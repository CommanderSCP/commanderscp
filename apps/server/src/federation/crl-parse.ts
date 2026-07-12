/**
 * Minimal, dependency-free X.509 CRL (`CertificateList`, RFC 5280 §5.1) reader — extracts only the
 * `nextUpdate` field. Deliberately NOT a general ASN.1/CRL library: air-gap/self-hosting (CLAUDE.md
 * principle 5) rules out adding a runtime dependency (e.g. `node-forge`) just to read one field out
 * of a file an operator already controls, and Node's own `tls`/`crypto` modules expose no CRL
 * parser at all (`crypto.X509Certificate` only covers certificates, not CRLs).
 *
 * Used by `config.ts`'s `loadFederationServerMtlsConfig` to implement the ADR-0001 "stale-CRL"
 * policy (`crlHardFailOnExpiry`): boot must know whether the configured CRL is already past its
 * `nextUpdate` *before* deciding whether to include it in the TLS context at all — see that
 * function's doc comment for why an EXPIRED CRL cannot simply be handed to Node's `https` server
 * unconditionally (empirically, doing so makes EVERY cert-presenting peer fail TLS verification
 * with `CRL_HAS_EXPIRED`, not just revoked ones — see config.ts).
 *
 * ASN.1 shape walked here (fields not read are still traversed, to skip past them):
 *   CertificateList ::= SEQUENCE {
 *     tbsCertList TBSCertList,
 *     signatureAlgorithm AlgorithmIdentifier,
 *     signatureValue BIT STRING }
 *   TBSCertList ::= SEQUENCE {
 *     version INTEGER OPTIONAL,        -- present only for a v2 CRL
 *     signature AlgorithmIdentifier,
 *     issuer Name,
 *     thisUpdate Time,
 *     nextUpdate Time OPTIONAL,        -- <-- the field this module reads
 *     revokedCertificates SEQUENCE OF ... OPTIONAL,
 *     crlExtensions [0] EXPLICIT Extensions OPTIONAL }
 *   Time ::= CHOICE { utcTime UTCTime, generalTime GeneralizedTime }
 */

const TAG_INTEGER = 0x02;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;

interface Tlv {
  tag: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset one past the last content byte. */
  contentEnd: number;
  /** Offset one past this whole TLV (== contentEnd; kept as a separate name for readability at
   *  call sites that advance a cursor). */
  end: number;
}

/** Strips PEM armor (`-----BEGIN X509 CRL-----` / `-----END X509 CRL-----`) and base64-decodes,
 *  if present; passes through unchanged if the input already looks like raw DER (starts with a
 *  SEQUENCE tag, 0x30, not the ASCII '-' of a PEM header). */
function pemToDer(input: Buffer): Buffer {
  if (input[0] === 0x30) return input; // already DER
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

/**
 * Returns the CRL's `nextUpdate` timestamp, or `null` if the CRL omits it (RFC 5280 marks it
 * OPTIONAL, though every CA in practice sets it — an absent `nextUpdate` is treated as "never
 * stale" by the caller, matching how most TLS stacks/CA tooling behave).
 *
 * Throws on anything that doesn't parse as a well-formed `CertificateList` — a corrupt/truncated
 * CRL file is a boot-time misconfiguration (config.ts's caller), not a value to silently treat as
 * "no expiry" (that would be a fail-OPEN bug: a garbled CRL must not look "fresh").
 */
export function parseCrlNextUpdate(pemOrDer: Buffer): Date | null {
  const der = pemToDer(pemOrDer);
  const outer = readTlv(der, 0); // CertificateList SEQUENCE
  const tbs = readTlv(der, outer.contentStart); // TBSCertList SEQUENCE
  let pos = tbs.contentStart;

  let field = readTlv(der, pos);
  if (field.tag === TAG_INTEGER) {
    // Optional `version` — present only on a v2 CRL (the only kind that carries extensions/CRL
    // number, so in practice always present, but read defensively per the OPTIONAL grammar).
    pos = field.end;
    field = readTlv(der, pos); // now `signature` AlgorithmIdentifier
  }
  pos = field.end; // past `signature` AlgorithmIdentifier
  field = readTlv(der, pos); // `issuer` Name
  pos = field.end;
  field = readTlv(der, pos); // `thisUpdate` Time
  pos = field.end;

  if (pos >= tbs.contentEnd) return null; // nothing follows thisUpdate at all
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
