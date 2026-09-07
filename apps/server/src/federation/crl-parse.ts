/** Minimal, dependency-free X.509 CRL. See docs/federation.md §61. */

const TAG_INTEGER = 0x02;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;

interface Tlv {
  tag: number;
  contentStart: number;
  contentEnd: number;
  /** Offset one past this whole TLV (== contentEnd; kept as a separate name for readability at
   *  call sites that advance a cursor). */
  end: number;
}

/** Strips PEM armor (`-----BEGIN X509 CRL-----` / `-----END X509 CRL-----`) and base64-decodes,
 *  if present; passes through unchanged if the input already looks like raw DER (starts with a
 *  SEQUENCE tag, 0x30, not the ASCII '-' of a PEM header). */
function pemToDer(input: Buffer): Buffer {
  if (input[0] === 0x30) return input;
  const text = input.toString("utf8");
  const base64 = text
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(base64, "base64");
}

/** Reads one DER TLV (tag-length-value) header at `offset`. Only handles the definite-length
 *  form (the only form X.509/CRL DER ever uses) and tags whose number fits in one byte (true for
 *  every tag this module cares about — INTEGER, SEQUENCE, UTCTime, GeneralizedTime, and the [0]
 *  context tag are all low tag numbers). */
function readTlv(buf: Buffer, offset: number): Tlv {
  if (offset + 2 > buf.length) {
    throw new Error(`malformed CRL: truncated TLV header at offset ${offset}`);
  }
  const tag = buf[offset]!;
  const lengthByte = buf[offset + 1]!;
  let length: number;
  let contentStart: number;
  if ((lengthByte & 0x80) === 0) {
    // Short form: the length byte IS the length (0-127).
    length = lengthByte;
    contentStart = offset + 2;
  } else {
    // Long form: low 7 bits of the length byte give the number of subsequent length octets.
    const numLengthBytes = lengthByte & 0x7f;
    if (numLengthBytes === 0 || numLengthBytes > 4) {
      // 0 = indefinite-length (BER, never valid DER); >4 would overflow a safe integer for any
      // CRL this codebase will ever be handed — treat both as malformed rather than looping.
      throw new Error(`malformed CRL: unsupported DER length encoding at offset ${offset}`);
    }
    contentStart = offset + 2 + numLengthBytes;
    length = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      length = length * 256 + buf[offset + 2 + i]!;
    }
  }
  const contentEnd = contentStart + length;
  if (contentEnd > buf.length) {
    throw new Error(`malformed CRL: TLV at offset ${offset} claims length past end of buffer`);
  }
  return { tag, contentStart, contentEnd, end: contentEnd };
}

/** Decodes an ASN.1 UTCTime (`YYMMDDHHMMSSZ`, two-digit year: 00-49 -> 20xx, 50-99 -> 19xx per
 *  RFC 5280 §4.1.2.5.1) or GeneralizedTime (`YYYYMMDDHHMMSSZ`) content into a `Date`. Assumes the
 *  `Z` (UTC) form — the only form a CA following RFC 5280 §5.1.2.4/§5.1.2.5 may emit for a CRL. */
function parseAsn1Time(buf: Buffer, tlv: Tlv): Date {
  const str = buf.subarray(tlv.contentStart, tlv.contentEnd).toString("ascii");
  if (tlv.tag === TAG_UTC_TIME) {
    const yy = Number(str.slice(0, 2));
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    return new Date(
      Date.UTC(
        year,
        Number(str.slice(2, 4)) - 1,
        Number(str.slice(4, 6)),
        Number(str.slice(6, 8)),
        Number(str.slice(8, 10)),
        Number(str.slice(10, 12))
      )
    );
  }
  return new Date(
    Date.UTC(
      Number(str.slice(0, 4)),
      Number(str.slice(4, 6)) - 1,
      Number(str.slice(6, 8)),
      Number(str.slice(8, 10)),
      Number(str.slice(10, 12)),
      Number(str.slice(12, 14))
    )
  );
}

/** The CRL's next-update timestamp, or null when omitted. See docs/federation.md §62. */
export function parseCrlNextUpdate(pemOrDer: Buffer): Date | null {
  const der = pemToDer(pemOrDer);
  const outer = readTlv(der, 0);
  const tbs = readTlv(der, outer.contentStart);
  let pos = tbs.contentStart;

  let field = readTlv(der, pos);
  if (field.tag === TAG_INTEGER) {
    // Optional `version` — present only on a v2 CRL (the only kind that carries extensions/CRL
    // number, so in practice always present, but read defensively per the OPTIONAL grammar).
    pos = field.end;
    field = readTlv(der, pos); // now `signature` AlgorithmIdentifier
  }
  pos = field.end;
  field = readTlv(der, pos);
  pos = field.end;
  field = readTlv(der, pos);
  pos = field.end;

  if (pos >= tbs.contentEnd) return null;
  const next = readTlv(der, pos);
  if (next.tag !== TAG_UTC_TIME && next.tag !== TAG_GENERALIZED_TIME) {
    // The next field present is `revokedCertificates` (SEQUENCE, tag 0x30) or `crlExtensions`
    // ([0], tag 0xA0) — nextUpdate was omitted.
    return null;
  }
  return parseAsn1Time(der, next);
}

/** `true` iff `nextUpdate` is in the past relative to `now` — `null` (no `nextUpdate` field at
 *  all) is never considered expired. */
export function isCrlExpired(nextUpdate: Date | null, now: Date = new Date()): boolean {
  if (nextUpdate === null) return false;
  return nextUpdate.getTime() < now.getTime();
}
