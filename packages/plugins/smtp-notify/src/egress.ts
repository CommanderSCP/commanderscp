import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** SSRF internal-range deny-list for `@scp/plugin-smtp-notify`. See docs/plugins.md §533. */

type IpClass = "loopback" | "linkLocal" | "unspecified" | "private" | "public";

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
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return "public";
}

export function classifyIp(rawIp: string): IpClass {
  const family = isIP(rawIp);
  if (family === 4) return classifyIpv4(rawIp);
  if (family !== 6) return "public";
  const ip = rawIp.toLowerCase();
  const v4Suffix = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Suffix && (ip.startsWith("::ffff:") || ip.startsWith("::")))
    return classifyIpv4(v4Suffix[1]!);
  if (ip === "::1") return "loopback";
  if (ip === "::") return "unspecified";
  if (/^fe[89ab]/.test(ip)) return "linkLocal";
  if (/^f[cd]/.test(ip)) return "private";
  return "public";
}

/** Throws if `host`. See docs/plugins.md §534. */
export async function assertHostNotInternal(host: string): Promise<string[]> {
  const stripped = host.replace(/^\[|\]$/g, "");
  const ips =
    isIP(stripped) !== 0
      ? [stripped]
      : (await lookup(stripped, { all: true })).map((r) => r.address);
  for (const ip of ips) {
    const cls = classifyIp(ip);
    if (cls !== "public") {
      throw new Error(
        `smtp-notify: host '${host}' resolves to ${ip} (${cls}) — internal egress blocked (SSRF)`
      );
    }
  }
  return ips;
}
