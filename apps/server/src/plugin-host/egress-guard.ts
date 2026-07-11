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
 *  - loopback (127/8, ::1), link-local incl. cloud metadata 169.254.169.254 (169.254/16, fe80::/10),
 *    and the unspecified address (0.0.0.0, ::) are ALWAYS blocked — for EVERY plugin, allowlisted
 *    or not: there is no legitimate reason a plugin should ever reach those.
 *  - private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) are blocked for a SCOPED plugin (one
 *    with a non-empty `allowedHosts`) — an allowlisted plugin targets a specific (public) API, so a
 *    resolution to a private IP is a rebinding/redirect attack ("the DB host is blocked even when
 *    allowlisted"). An UNSCOPED escape hatch (empty `allowedHosts` — webhook-control's
 *    arbitrary-URL POST, federation-https's on-prem peers) is deliberately permitted to reach
 *    private ranges (but never loopback/link-local). An M7 integration that genuinely must reach a
 *    private-IP on-prem API runs unscoped, a documented tradeoff.
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
 * Throws (an `EgressGuardError`) if `url` is not a permitted egress target for a plugin instance
 * whose allowlist is `allowedHosts`. Enforced AFTER DNS resolution — see module doc for the rule.
 */
export async function assertEgressAllowed(url: string, allowedHosts: string[]): Promise<void> {
  // `URL.hostname` wraps an IPv6 literal in brackets (`[::1]`) — strip them so `isIP`/`classifyIp`
  // and the allowlist comparison see the bare address.
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const scoped = allowedHosts.length > 0;
  if (scoped && !allowedHosts.includes(hostname)) {
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
    if (cls === "loopback" || cls === "linkLocal" || cls === "unspecified") {
      throw blocked(
        `egress guard: '${hostname}' resolves to ${ip} (${cls}) — never a permitted plugin egress target (SSRF)`
      );
    }
    if (cls === "private" && scoped) {
      throw blocked(
        `egress guard: allowlisted host '${hostname}' resolves to private ${ip} — blocked (DNS-rebinding/redirect defense)`
      );
    }
  }
}
