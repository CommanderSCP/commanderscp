import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from "node:crypto";

/**
 * A SELF-SIGNED SERVER CERTIFICATE, minted once (M29.4). argo-server mints a fresh one on every
 * start unless handed a Secret, which makes its CA unpinnable (`scripts/scp-bundled.sh`
 * `ensure_argo_server_tls` measured three fingerprints across three restarts). The controller
 * mints it the first time Argo Workflows is enabled and never again while the Secret exists.
 *
 * Node can sign but cannot build an X.509 certificate, and the image carries no openssl CLI, so
 * the DER below is written by hand: an ECDSA P-256 key, v3, SANs for every name SCP may dial,
 * `CA:TRUE` because the certificate is its own trust anchor (SCP pins it as the CA).
 */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 + n, inner);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bitString = (b: Buffer, unusedBits = 0): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]));

function integer(b: Buffer): Buffer {
  let body = b;
  while (body.length > 1 && body[0] === 0 && (body[1]! & 0x80) === 0) body = body.subarray(1);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128))
      stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  // RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
  return y < 2050
    ? tlv(0x17, Buffer.from(`${pad(y % 100)}${rest}`))
    : tlv(0x18, Buffer.from(`${y}${rest}`));
}

const x500Name = (organization: string, commonName: string): Buffer =>
  seq(set(seq(oid("2.5.4.10"), utf8(organization))), set(seq(oid("2.5.4.3"), utf8(commonName))));

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const pem = (label: string, der: Buffer): string =>
  `-----BEGIN ${label}-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;

export interface MintedCertificate {
  certPem: string;
  keyPem: string;
}

export function mintSelfSignedCertificate(opts: {
  commonName: string;
  dnsNames: string[];
  validDays: number;
  now?: Date;
  key?: KeyObject;
}): MintedCertificate {
  const privateKey = opts.key ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const notBefore = opts.now ?? new Date();
  const notAfter = new Date(notBefore.getTime() + opts.validDays * 86_400_000);
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01; // positive and non-zero
  const sigAlg = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const subject = x500Name("CommanderSCP", opts.commonName);
  const san = seq(...opts.dnsNames.map((d) => tlv(0x82, Buffer.from(d, "ascii"))));
  const extensions = seq(
    extension("2.5.29.19", true, seq(bool(true))), // basicConstraints CA:TRUE
    // keyUsage digitalSignature (bit 0) | keyCertSign (bit 5): 0b1000_0100, two unused bits.
    extension("2.5.29.15", true, bitString(Buffer.from([0x84]), 2)),
    extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage serverAuth
    extension("2.5.29.17", false, san)
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    sigAlg,
    subject,
    seq(time(notBefore), time(notAfter)),
    subject,
    spki,
    explicit(3, extensions)
  );
  const signature = sign("sha256", tbs, privateKey);
  return {
    certPem: pem("CERTIFICATE", seq(tbs, sigAlg, bitString(signature))),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}
