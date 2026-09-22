# ADR-0051: SSH credentials are requested where possible and minted per-domain where not — and the CA-compromise analysis ADR-0002 requires

**Status:** Accepted (owner rulings 2026-09-22)
**Amends:** [ADR-0002](0002-execution-strategy.md) — the "Mode C — SSH-CA discipline" precondition, specifically its *"CA-key protection commensurate with a fleet root of trust (HSM/KMS or offline signing)"* clause. That clause is **relaxed by explicit owner decision**; §D3 below records what was traded and what compensates. The precondition's other clauses (blast-radius analysis, short lifetimes, air-gap-workable rotation and revocation, justification of the standing footprint) are **satisfied here, not waived**.
**Relates to:** [ADR-0050](0050-runner-ops-lockdown-is-an-allowlist.md) (the other open `scp-runner-ops` precondition); [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) Managed Execution Exception (2026-07-12 host-reaching amendment) and principle 5 (air-gap first-class); [docs/proposals/managed-execution-tier.md](../proposals/managed-execution-tier.md) §2 and its [MAJOR] guardian caveat; [DESIGN.md](../DESIGN.md) §12

## Context

`scp-runner-ops` needs to log in to hosts. The tier proposal's recommendation is that SCP act as an
SSH CA issuing minutes-TTL certificates scoped per-target/per-run, against a restricted sudoers —
and its own guardian review flags the result as a **new fleet-wide crown jewel**, worse in the
worst case than the static keys it replaces.

**A correction the design needs first.** ADR-0002, DESIGN.md §12 and the tier proposal all describe
a compromised CA as minting *"valid host certs for the entire fleet"*. The credential this runner
requires is a **user certificate** — it authenticates *to* hosts. The two differ sharply:

| | compromised | worst case |
|---|---|---|
| **User CA** (hosts trust it via `TrustedUserCAKeys`) | mint a cert naming any principal | **log in to every trusting host**, as whatever principal the sudoers permits |
| **Host CA** (clients trust it) | mint host certs | impersonate hosts to clients — MITM |

The design requires the **user CA**, which is the more dangerous of the two. This ADR is written
against that, and the milder wording elsewhere should be read as an error rather than a narrower
scope.

## Decision

**D1 — Requested where possible, minted where not.** SCP integrates with an existing credential
authority (HashiCorp Vault's SSH secrets engine, Teleport, or an org's own CA) and *requests* a
short-lived certificate per run. Where an org has no such authority — which is the case Mode C
exists to serve — SCP falls back to its own CA. BYO is the **preferred and documented default**; the
SCP-CA path is the fallback.

**D2 — One CA per domain/segment.** Never fleet-wide. This follows the tier proposal's existing rule
that a runner is domain-local per segment and never bridges trust boundaries; a fleet-wide CA would
contradict it at the credential layer. A compromise is bounded to the hosts of one domain.

**D3 — The signing key lives in SCP's existing encrypted credential store** (AES-256-GCM at rest,
org-scoped RLS, decrypted only at provisioning, redacted from evidence), **not in an HSM or KMS.**

This is a deliberate relaxation of ADR-0002, taken with the trade stated rather than implied:

- *Why not cloud KMS:* charter principle 5 makes air-gap first-class and forbids runtime calls
  outside the domain. An air-gapped outpost cannot reach AWS/GCP/Azure KMS, so a KMS-only design
  makes host-reaching managed execution unavailable in exactly the deployments this platform exists
  for.
- *Why not pure offline signing:* minutes-TTL, per-run issuance requires the key to be reachable at
  run time. An offline root forces an online intermediate, and the intermediate then becomes the
  same crown jewel with more machinery around it.
- *Why not mandate a hardware token:* it would make physical hardware a precondition of a software
  feature in every domain that wants it, including every outpost.
- *What compensates:* D1 means high-assurance estates use their own authority and never create this
  key at all; D2 bounds any compromise to one segment; the closed cosign-signed catalog
  ([ADR-0050](0050-runner-ops-lockdown-is-an-allowlist.md)) bounds what a valid cert can *do*;
  restricted sudoers bounds it again at the host; the per-run positive network allowlist bounds
  reachability; and D5 below makes forgery detectable.
- *What is genuinely worse:* anyone who can read the credential store, or dump `scpd`'s memory at
  provisioning time, obtains a segment-wide login credential. An HSM would make the key
  non-exportable and reduce that to "can request signatures while they have access". **That
  reduction is given up.** The uncomfortable corner is named explicitly: an air-gapped high-side
  domain is both the most sensitive deployment and the least likely to have a BYO authority, so it
  is the most likely to run the weaker custody path.

**D4 — The standing host footprint is accepted and justified, not engineered away.** Hosts carry
`TrustedUserCAKeys` in `sshd_config` and a restricted sudoers entry naming exactly the catalog's
commands (never `NOPASSWD:ALL`). This is categorically smaller than the AWX/Salt agent shape the
charter rejects: it is **static configuration** — no running daemon, no scheduled callback, no
standing network listener beyond the `sshd` the host already runs, and no SCP code resident on the
host. The footprint is two files, and the host initiates nothing.

**D5 — Every issued certificate carries a serial SCP records, and forgery is detectable.** SCP
allocates a serial per certificate and writes it to the hash-chained audit log in the same
transaction as the issuance (principle 6). Hosts log the serial of every certificate presented.
A certificate accepted by a host whose serial SCP never issued **is** evidence of CA-key compromise.
Without this, a compromised CA is silent; with it, reconciliation is a detective control that does
not depend on the attacker being noisy.

## The CA-compromise blast-radius analysis (ADR-0002 precondition)

**Scope of authority.** A compromised per-domain user CA key lets an attacker mint certificates
naming any principal, accepted by every host in that domain configured to trust it. Combined with
the pre-seeded sudoers, the practical ceiling is the catalog's command set as root — and the sudoers
restriction is the only thing holding that line, because a forged certificate is indistinguishable
from a legitimate one at the point of authentication.

**Short TTLs do not bound this, and the design must not pretend they do.** `sshd` honours the
validity interval *inside the certificate*, and an attacker holding the CA key chooses that interval.
Minutes-TTL is a property of SCP's issuance policy, binding only on SCP. It bounds the damage of a
**leaked certificate**; it does nothing about a **compromised CA key**, which can mint a decade-long
credential. The only real controls against key compromise are revocation, rotation, and detection.

**Containment.** D2 bounds the reachable set to one domain's hosts. Cross-domain movement is not
available from this credential: federation moves signed journals, not sessions, and the tier design
already forbids a runner bridging segments.

**Revocation.** SSH has no CRL fetch. Revoking specific certificates means distributing a KRL to
every trusting host; revoking the CA means replacing `TrustedUserCAKeys` on every trusting host.
Both are fleet-wide configuration pushes. In a connected domain this is an ordinary config
management action. **In an air-gapped domain it is an operator convoy**, and its duration is the
real exposure window — which is why D5's detection matters more here than in a connected estate.

**Rotation.** CA keys rotate on a schedule and on suspicion. Hosts must trust the incoming CA before
the outgoing one is withdrawn, so rotation is two pushes, not one, and a domain mid-rotation trusts
two CAs — doubling the blast radius for that window. Rotation cadence is therefore a real cost, not
a free mitigation.

**Recovery.** Because revocation is a push, every domain running the SCP-CA path needs a
pre-positioned break-glass: an access path that does not depend on the compromised CA. An estate
whose *only* access route is SCP's CA cannot recover from SCP's CA being compromised, and that
circularity must be closed at enrolment rather than discovered during an incident.

## Consequences

- **The build is unblocked on this precondition**, with ADR-0050 covering the other. What remains
  before `scp-runner-ops` starts is implementation, not a further decision.
- **ADR-0002's HSM/KMS clause no longer holds as written.** It is amended here by owner decision
  with the trade recorded; a future move to hardware custody is an improvement to this ADR, not a
  correction of a mistake.
- **BYO must be built first, not second.** D1 makes the SCP-CA the fallback, and a fallback built
  first tends to become the default by inertia. The integration path is the primary deliverable.
- **D5 imposes real work on both ends** — serial allocation and audit persistence in SCP, and host
  log collection that the reconciliation can read. A detective control nobody reads is not a control.
- **Break-glass is a precondition of enrolment**, per the recovery paragraph. Enrolling a domain into
  SCP's CA without an independent access path creates an unrecoverable estate.
