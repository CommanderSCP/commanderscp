import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { federationPeerSanUri, parsePeerDomainIdFromSanUri } from "./mtls-enforcement.js";

/**
 * Pure-function coverage for the SAN URI identity scheme (ADR-0001 — `urn:scp:domain:<domainId>`,
 * chosen over `spiffe://` and over the certificate's CN). No DB, no TLS socket — the fail-closed
 * behavior these guard (reject on ANY parse ambiguity) is what `mtls.integration.test.ts` proves
 * end-to-end against a real TLS connection; this file is the fast, exhaustive edge-case sweep.
 */
describe("federation SAN URI identity (ADR-0001)", () => {
  it("round-trips a domain id through federationPeerSanUri -> parsePeerDomainIdFromSanUri", () => {
    const domainId = randomUUID();
    const uri = federationPeerSanUri(domainId);
    expect(uri).toBe(`urn:scp:domain:${domainId}`);
    // Mimics Node's tls.TLSSocket#getPeerCertificate().subjectaltname format for a cert with
    // exactly one URI SAN (comma-space-joined if there were more).
    expect(parsePeerDomainIdFromSanUri(`URI:${uri}`)).toBe(domainId);
  });

  it("finds the URI SAN among other SAN entry types, in either position", () => {
    const domainId = randomUUID();
    const uri = `URI:${federationPeerSanUri(domainId)}`;
    expect(parsePeerDomainIdFromSanUri(`DNS:example.com, ${uri}`)).toBe(domainId);
    expect(parsePeerDomainIdFromSanUri(`${uri}, IP Address:127.0.0.1`)).toBe(domainId);
  });

  it("rejects (returns null) when subjectaltname is undefined — no cert / no SAN extension at all", () => {
    expect(parsePeerDomainIdFromSanUri(undefined)).toBeNull();
  });

  it("rejects (returns null) an empty string", () => {
    expect(parsePeerDomainIdFromSanUri("")).toBeNull();
  });

  it("rejects (returns null) a URI SAN with a different scheme (e.g. spiffe://)", () => {
    expect(parsePeerDomainIdFromSanUri("URI:spiffe://example.org/ns/default/sa/child-domain")).toBeNull();
  });

  it("rejects (returns null) a urn:scp:domain: value that isn't a valid UUID", () => {
    expect(parsePeerDomainIdFromSanUri("URI:urn:scp:domain:not-a-uuid")).toBeNull();
  });

  it("rejects (returns null) when only a DNS SAN is present, no URI SAN at all", () => {
    expect(parsePeerDomainIdFromSanUri("DNS:example.com, IP Address:127.0.0.1")).toBeNull();
  });

  it("preserves internal colons in the URN (only the 'URI:' prefix itself is stripped)", () => {
    const domainId = randomUUID();
    // Sanity: the URN itself contains three colons ("urn:scp:domain:<uuid>") in addition to the
    // "URI:" prefix's own colon — a naive split-on-first-colon (rather than prefix-strip) would
    // mis-parse this.
    const uri = `URI:urn:scp:domain:${domainId}`;
    expect(uri.split(":").length).toBeGreaterThan(4);
    expect(parsePeerDomainIdFromSanUri(uri)).toBe(domainId);
  });
});
