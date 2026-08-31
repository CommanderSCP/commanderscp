import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF egress guard for plugin `ctx.http` (adversarial-review MAJOR #6). The `allowedHosts`
 * allowlist alone doesn't stop (a) a plugin being steered at the cloud metadata endpoint /
 * loopback / an internal service, or (b) an allowlisted HOSTNAME that DNS-resolves (or rebinds) to
 * an internal IP. This adds an internal-range deny-list enforced AFTER DNS resolution, plus the
 * caller disables HTTP redirect-following (a redirect can't be re-pointed at an internal host).
 *
 * The rule (see `assertEgressAllowed`):
 *  - link-local incl. cloud metadata 169.254.169.254 (169.254/16, fe80::/10) and the unspecified
 *    address (0.0.0.0, ::) are ALWAYS blocked — for EVERY plugin, no exceptions: no plugin ever
 *    legitimately reaches the metadata endpoint.
 *  - loopback (127/8, ::1) and private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7)
 *    are blocked UNLESS `allowInternalPrivate` is true. That flag is derived by the CALLER from the
 *    plugin's MODULE IDENTITY (subprocess-entry.ts's `OPERATOR_PLANE_MODULES`), NEVER from tenant
 *    config: only the genuine operator-plane escape hatches — `webhook-control` (its control-server
 *    URL is operator-configured behind `policy:write`) and `federation-https` (on-prem/single-host
 *    peers) — may reach internal hosts. EVERY tenant-configurable plugin (webhook-notify, github,
 *    argocd, terraform, managed-iac) has `allowInternalPrivate === false`, so a tenant that creates
 *    a binding with `config.url = http://127.0.0.1/...` or `http://10.x/internal` is BLOCKED —
 *    closing the SSRF hole an earlier "unscoped ⇒ allowed" heuristic (based on `allowedHosts`
 *    emptiness, which tenant bindings default to) had reopened. The `allowedHosts` allowlist is a
 *    SEPARATE, additional gate (a scoped plugin's hostname must be on it); it does NOT decide the
 *    internal-range allowance.
 *
 * Classifying an address is worth nothing unless it is the address actually dialled, so
 * `assertEgressAllowed` RETURNS what it verified and `createEgressPinRegistry` (below) makes that
 * set the only answer the connect-time resolver will give — see its doc for the rebinding window
 * that was open while the HTTP client resolved the name a second time on its own.
 */

export type IpClass = "loopback" | "linkLocal" | "unspecified" | "private" | "public";

function classifyIpv4(ip: string): IpClass {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return "public";
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "linkLocal"; // incl. 169.254.169.254 cloud metadata
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
  if (ip.startsWith("fc") || ip.startsWith("fd")) return "private"; // fc00::/7 unique-local
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

/**
 * Throws (an `EgressGuardError`) if `url` is not a permitted egress target; returns the addresses
 * it verified. Enforced AFTER DNS resolution — see module doc. `allowInternalPrivate` MUST be
 * derived from the plugin's module identity by the caller (never from tenant config), and is true
 * ONLY for the operator-plane escape hatches.
 *
 * Returning the verified addresses is not a convenience: a caller that then lets the HTTP client
 * re-resolve the name has verified nothing (DNS rebinding, see {@link createEgressPinRegistry}).
 */
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

/**
 * Closes the TOCTOU between "the guard classified this name's addresses" and "the socket connected
 * somewhere". `assertEgressAllowed` used to be followed by a `fetch(url)` that performed its OWN,
 * INDEPENDENT `getaddrinfo` at connect time, so a hostname whose DNS an attacker controls could
 * answer the guard with a public address and the connect-time query, milliseconds later, with
 * `127.0.0.1` / `10.x` / `169.254.169.254` — a textbook DNS rebind that defeated every check above
 * for every tenant-configurable plugin.
 *
 * The registry's `lookup` is installed as the undici Agent's `connect.lookup`, which is the ONLY
 * resolver the socket ever consults. It answers exclusively from the pin the guard just wrote, so
 * the address connected to is provably the address classified; an unpinned hostname is refused
 * outright rather than falling back to DNS. The name itself still travels to the transport (TLS
 * SNI and certificate verification are unaffected — only the address selection is pinned).
 *
 * Pins are REFERENCE-COUNTED, not last-write-wins: two concurrent requests to one hostname each
 * hold the pin until their own body is read, so the first to finish cannot pull the address out
 * from under the second's in-flight connect.
 */
export interface EgressPinRegistry {
  /** Pins `target.hostname` to `target.ips`; call the returned release once the response body is
   *  fully read (the connection is long since established by then). */
  pin(target: VerifiedEgressTarget): () => void;
  /** `net.LookupFunction`-shaped — pass as an undici Agent's `connect.lookup`. */
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
