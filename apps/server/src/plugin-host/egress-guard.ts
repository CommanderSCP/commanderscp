import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";

/** SSRF egress guard for plugin `ctx.http`. See docs/plugin-host.md §28. */

export type IpClass = "loopback" | "linkLocal" | "unspecified" | "private" | "public";

function classifyIpv4(ip: string): IpClass {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return "public";
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "linkLocal";
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64/10 carrier-grade NAT (RFC 6598)
  return "public";
}

export function classifyIp(rawIp: string): IpClass {
  const family = isIP(rawIp);
  if (family === 4) return classifyIpv4(rawIp);
  if (family !== 6) return "public"; // not an IP literal — caller resolves DNS first

  const ip = rawIp.toLowerCase();
  // IPv4-mapped/-compatible (::ffff:a.b.c.d or ::a.b.c.d) — classify the embedded IPv4.
  const v4Suffix = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Suffix && (ip.startsWith("::ffff:") || ip.startsWith("::"))) {
    return classifyIpv4(v4Suffix[1]!);
  }
  if (ip === "::1") return "loopback";
  if (ip === "::") return "unspecified";
  if (
    ip.startsWith("fe80") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  ) {
    return "linkLocal"; // fe80::/10
  }
  if (ip.startsWith("fc") || ip.startsWith("fd")) return "private";
  return "public";
}

/** Resolves a hostname to every address it currently answers with. Injectable ONLY so the pinning
 *  tests below can hand the guard a rebinding resolver; production always uses `systemResolver`. */
export type EgressResolver = (hostname: string) => Promise<string[]>;

const systemResolver: EgressResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((r) => r.address);

/** All IPs a hostname resolves to (or the literal IP itself). Throws if resolution fails — a name
 *  we can't resolve can't be verified, so it's blocked rather than trusted. */
async function resolveHostIps(hostname: string, resolve: EgressResolver): Promise<string[]> {
  if (isIP(hostname) !== 0) return [hostname];
  return resolve(hostname);
}

export interface EgressGuardError extends Error {
  egressBlocked: true;
}

function blocked(message: string): EgressGuardError {
  return Object.assign(new Error(message), { egressBlocked: true as const });
}

/** The hostname the caller asked for and the EXACT addresses this guard classified as permitted.
 *  Feed it to {@link EgressPinRegistry.pin} so the socket cannot be opened to any other address. */
export interface VerifiedEgressTarget {
  hostname: string;
  ips: string[];
}

/** Throws if the URL is not a permitted egress target. See docs/plugin-host.md §29. */
export async function assertEgressAllowed(
  url: string,
  allowedHosts: string[],
  allowInternalPrivate: boolean,
  resolve: EgressResolver = systemResolver
): Promise<VerifiedEgressTarget> {
  // `URL.hostname` wraps an IPv6 literal in brackets (`[::1]`) — strip them so `isIP`/`classifyIp`
  // and the allowlist comparison see the bare address.
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    throw blocked(
      `scoped http client: host '${hostname}' is not in the configured allowedHosts allowlist`
    );
  }

  let ips: string[];
  try {
    ips = await resolveHostIps(hostname, resolve);
  } catch (err) {
    throw blocked(
      `egress guard: could not resolve '${hostname}' (${err instanceof Error ? err.message : String(err)})`
    );
  }

  for (const ip of ips) {
    const cls = classifyIp(ip);
    // link-local (cloud metadata) + unspecified: blocked for EVERY plugin, always.
    if (cls === "linkLocal" || cls === "unspecified") {
      throw blocked(
        `egress guard: '${hostname}' resolves to ${ip} (${cls}) — never a permitted plugin egress target (SSRF)`
      );
    }
    // loopback + private: blocked for every TENANT-configurable plugin; permitted only for an
    // operator-plane escape hatch (allowInternalPrivate — module identity, not tenant config).
    if ((cls === "loopback" || cls === "private") && !allowInternalPrivate) {
      throw blocked(
        `egress guard: host '${hostname}' resolves to ${cls} ${ip} — internal egress blocked for this plugin (SSRF)`
      );
    }
  }
  return { hostname, ips };
}

/** Closes the gap between classifying a name and dialling it. See docs/plugin-host.md §30. */
export interface EgressPinRegistry {
  /** Pins `target.hostname` to `target.ips`; call the returned release once the response body is
   *  fully read (the connection is long since established by then). */
  pin(target: VerifiedEgressTarget): () => void;
  lookup: LookupFunction;
}

export function createEgressPinRegistry(): EgressPinRegistry {
  const pins = new Map<string, { ips: string[]; refs: number }>();
  return {
    pin(target) {
      const key = target.hostname.replace(/^\[|\]$/g, "");
      const existing = pins.get(key);
      if (existing) {
        existing.ips = target.ips; // Both sets are guard-verified; the newest is the freshest DNS.
        existing.refs += 1;
      } else {
        pins.set(key, { ips: [...target.ips], refs: 1 });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const entry = pins.get(key);
        if (!entry) return;
        entry.refs -= 1;
        if (entry.refs <= 0) pins.delete(key);
      };
    },
    lookup(hostname, options, callback) {
      const entry = pins.get(hostname.replace(/^\[|\]$/g, ""));
      if (!entry || entry.ips.length === 0) {
        callback(
          blocked(
            `egress guard: refusing to resolve '${hostname}' at connect time — only addresses this ` +
              `guard verified may be connected to (DNS rebinding)`
          ),
          []
        );
        return;
      }
      const records = entry.ips.map((address) => ({
        address,
        family: isIP(address) === 6 ? 6 : 4
      }));
      const wanted =
        options.family === 4 || options.family === 6
          ? records.filter((r) => r.family === options.family)
          : records;
      if (wanted.length === 0) {
        callback(
          blocked(`egress guard: '${hostname}' has no verified address in the requested family`),
          []
        );
        return;
      }
      if (options.all) callback(null, wanted);
      else callback(null, wanted[0]!.address, wanted[0]!.family);
    }
  };
}
