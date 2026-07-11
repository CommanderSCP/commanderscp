import { isIP } from "node:net";
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

/** All IPs a hostname resolves to (or the literal IP itself). Throws if resolution fails — a name
 *  we can't resolve can't be verified, so it's blocked rather than trusted. */
async function resolveHostIps(hostname: string): Promise<string[]> {
  if (isIP(hostname) !== 0) return [hostname];
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

export interface EgressGuardError extends Error {
  egressBlocked: true;
}

function blocked(message: string): EgressGuardError {
  return Object.assign(new Error(message), { egressBlocked: true as const });
}

/**
 * Throws (an `EgressGuardError`) if `url` is not a permitted egress target. Enforced AFTER DNS
 * resolution — see module doc. `allowInternalPrivate` MUST be derived from the plugin's module
 * identity by the caller (never from tenant config), and is true ONLY for the operator-plane
 * escape hatches.
 */
export async function assertEgressAllowed(
  url: string,
  allowedHosts: string[],
  allowInternalPrivate: boolean
): Promise<void> {
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
    ips = await resolveHostIps(hostname);
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
}
