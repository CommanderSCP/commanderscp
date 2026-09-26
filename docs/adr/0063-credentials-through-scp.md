# ADR-0063: Credentials a bundled backend needs are entered through SCP, sealed to the stack controller, and written by it into the backend's own Secret — scpd keeps nothing it could read back

**Status:** Accepted (2026-09-25) — implements M29.5 (docs/BUILD_AND_TEST.md §M29) and proposal D2 (docs/proposals/zero-to-running.md §7 Q2 (a), "workload identity preferred"); the calls marked *this increment's* below are the owner's to overrule
**Relates to:** PROJECT_CHARTER.md "Managed Standard Stack" ("CommanderSCP brokers them in, it does not hold them"), "CommanderSCP Is the Surface"; ADR-0058 (the stack controller, its namespace isolation, the instance audit chain); ADR-0061 (the controller → scpd hand-off, the opposite direction); ADR-0053/0056 (the build and infra catalog templates that mount these Secrets); drizzle/0130

## Context

The bundled Argo Workflows' catalog templates read three Secrets in their namespace:
`scp-build-registry` (the build templates' source token and registry push credential) and
`scp-infra-plan-credentials` / `scp-infra-apply-credentials` (the infra plan/apply cloud and
state-backend credentials, every key an environment variable). Until M29.5 an operator made them
with `kubectl create secret` — the step the proposal's §2 table names as the gap, and the charter's
"CommanderSCP is the surface" forbids. The charter's amendment is precise about how they may travel:
*entered through CommanderSCP and handed to the backend by the stack controller … the coordination
server never persists a backend credential and has no path to read one back; the audit record names
who wrote which key, never the value.*

## Decision

1. **A fixed catalog, never free-form** (`STACK_CREDENTIAL_CATALOG`, `@scp/schemas`). Backend →
   Secret → keys, each described. The Secret names are the bundled chart's defaults
   (`credentials.test.ts` holds the two together). The infra keys are an enumerated list of cloud and
   state-backend variables, because every key of those Secrets becomes an environment variable of a
   pod that runs a repository's own code: a free key could set `LD_PRELOAD`, `TF_CLI_CONFIG_FILE` or
   `PATH` (`stack-credentials.test.ts` holds the list away from those). Widening it is a schema
   change. Both scpd (before sealing) and the controller (after opening) check the pair.

2. **The hand-off is a sealed envelope, not a value.**
   - The controller holds an **X25519 key pair**; the private half lives in a Secret in the
     controller's OWN namespace (ADR-0058 §6: no other identity the chart renders can read there)
     and is generated there on first run. It publishes the public half through its own door
     (`PUT /instance/stack/credential-sealing-key`, the controller's `stack-controller` credential
     only), and scpd hands the key's sha256 back in the spec so a lost or stale record is re-published.
   - `PUT /instance/stack/credentials/{backend}/{secretName}/{key}` (instance authority: the
     instance-operator role on a session, or a full operator credential) takes the value and, in the
     same request, **seals** it — an ephemeral X25519 key, HKDF-SHA256, AES-256-GCM — with the
     delivery's whole header (delivery id, sequence, backend, Secret, key, op, key id, `notAfter`)
     as the GCM additional data. Only the envelope is stored (`stack_credentials`, drizzle/0130).
     scpd holds no private key: nothing scpd has — its database, its master key, its memory after the
     request — opens it. The plaintext's one scpd copy the process cannot scrub is the request body's
     string, which goes with the request; the Buffer the seal reads is zeroed.
   - Every tick (and after each backend, so a long install does not delay it) the controller reads
     the pending envelopes (`GET /instance/stack/credential-deliveries`, its credential only), and for
     each: holds the target to the catalog it carries, checks the key id and `notAfter`, refuses one
     sealed no later than the last it applied to that target, OPENS it, writes the key into the
     backend namespace's Secret — the namespace derived from the backend by the controller, never
     read from anywhere — by server-side apply under a field manager per key (one key never drops
     another), records it, and confirms (`POST …/{deliveryId}/ack`). scpd then nulls the envelope. A
     refusal is confirmed with a reason code (`tampered`, `wrong-key`, `replayed`, `expired`,
     `not-in-catalog`); nothing the controller opened ever travels back.
   - **Rotation** is a re-set (the envelope replaces the pending one; the controller's write
     replaces the value). **Deletion** is a sealed `delete` (an empty plaintext) the controller
     applies as a merge patch removing just that key.

3. **The M28 class, answered for the envelope** — "a value that decides WHERE work goes or WITH
   WHAT AUTHORITY, writable by someone who could not otherwise grant it":
   - *Who can read it:* `stack_credentials` has no `scp_app` grant at all (not even SELECT); only
     `scp_operator` reads it, and what it reads is ciphertext sealed to a key only the controller's
     namespace holds.
   - *Who can replay it:* the controller refuses an envelope sealed no later than the last it applied
     to that target, and any past `notAfter` (sealing time + 1 h). **Ordered by sealing time, not by
     scpd's sequence — found on kind:** a fresh scpd's first credential was refused as a replay of
     the previous scpd's, because a restored or rebuilt database restarts the sequence (the clock
     does not go back). The lost-acknowledgement case (the same delivery again) is confirmed, not
     re-written.
   - *Who can redirect it:* the target is in the additional data, so a row whose backend, Secret,
     key, op or sequence was rewritten in the table fails the tag (`tampered`); the namespace is never
     sent at all.
   - *Who can forge one:* anyone holding the public key can seal SOMETHING — but the only writer of
     the table is `scp_operator`, which is instance authority already (the API door requires the
     same), and the target is still held to the catalog. Stated, not hidden: the envelope is
     confidential and bound, not signed by scpd.
   - *Who can re-point the key:* only the controller's credential publishes it. A changed key
     strands every envelope sealed to the old one: they are marked failed, for the operator to enter
     again (scpd cannot re-seal what it never kept).

4. **The push credential is bound to one host** (*this increment's*, found while building the DoD).
   The build templates present the push token to the host of `imageDestination` / `rpmUploadUrl`,
   which SCP assembles from a registry object an organization writes — so an unbound token goes
   wherever that object points (the M28 shape, pre-existing). The catalog gains `registryHost`, and
   both templates refuse a destination on any other host BEFORE the credential is written anywhere
   (`scp-build-image-v1`'s script; `build-rpm.sh`). A Secret without it (made before M29.5) keeps
   working, with a warning line, so existing installs do not break on upgrade; the Stack page names
   the missing key as a need. helm-verify holds both templates to the binding.

5. **Workload identity is preferred where the substrate provides it.** A declaration
   (`PUT /instance/stack/workload-identities/{backend}/{serviceAccount}`, instance authority) names
   an enumerated ServiceAccount — `scp-infra-plan`, `scp-infra-apply` (Argo Workflows),
   `argocd-application-controller`, `argocd-server` (Argo CD); **never `scp-build`**, whose pods run
   a tenant's Dockerfile — and one of the supported providers, each with its identifier's anchored
   pattern:
   - `aws-irsa` — annotation `eks.amazonaws.com/role-arn`, an IAM role ARN;
   - `gke-workload-identity` — `iam.gke.io/gcp-service-account`, a Google service account email;
   - `azure-workload-identity` — `azure.workload.identity/client-id`, a GUID, plus the webhook's pod
     label `azure.workload.identity/use: "true"`.
   (EKS Pod Identity needs nothing in-cluster, so there is nothing to declare.) The declarations
   reach the controller in its spec (the spec census admits these three patterns at that one path
   and nowhere else); the controller sets the annotation on the ServiceAccount **in its own render**
   — an annotation value on an object it builds, never through helm values — the label where
   needed, and a digest annotation on each pod template running as it so the workloads roll. A
   declaration whose ServiceAccount the release does not install (infra plan/apply before a state
   backend is configured) is a need on the Stack page, not silence. The cloud side (the role's trust
   of `system:serviceaccount:<namespace>:<serviceAccount>`) is what grants authority; the annotation
   alone grants nothing.

6. **No read route** — held by a census over the whole emitted contract
   (`stack-credential-no-read.test.ts`): the only request body carrying a `value` is the set; no stack
   response schema has a property that could hold one; the sealed envelope is returned by the
   controller's delivery list alone; the credential paths are list, set and delete. The read model
   (`GET /instance/stack/credentials`) is metadata: state (`unset`/`pending`/`set`/`failed`), who
   asked, when it was delivered, the refusal reason.

7. **Audit.** Every set, delete, delivery, refusal and key publication appends to
   `instance_audit_events` in the same transaction: actor, backend, Secret, key, delivery id,
   sequence — never the value. Workload-identity declarations record the identifier (it names a
   cloud identity; it is not a secret).

8. **Two chart facts the real build needed** (both in the same increment, both measured on kind):
   Gitea's `ROOT_URL` was the placeholder `http://git.example.com`, so its registry's token realm
   was unresolvable from a build pod — it is now the in-cluster Service; and the build templates
   could fetch only `https://<sourceHost>` and push only over TLS — `sourceHost` may now carry a
   scheme (`http://scp-gitea-http.scp-gitea.svc:3000`), and a push to an in-cluster Service
   (`*.svc[.cluster.local]`) is plain HTTP, the way SCP itself reaches Gitea behind its policies.

## Consequences

- Parity: API → SDK (`ScpClient.stack.credentials / setCredential / deleteCredential /
  putWorkloadIdentity / deleteWorkloadIdentity`, and the controller's `putSealingKey /
  credentialDeliveries / ackCredentialDelivery`) → CLI (`scp stack credential list|set|delete`, the
  value from a hidden prompt, stdin or `--from-file`, never an argument; `scp stack workload-identity
  set|delete`) → UI (Admin › Stack › Credentials). IaC: not applicable, as ADR-0058 §8 — instance-tier
  operator configuration, and a credential in an org's program would be exactly the M28 hole.
- The controller now uses seven API operations (`controller-inputs.test.ts`).
- **Proved on kind** (`stack-credentials.kind.test.ts`, CI job 4e): a push token minted on the
  bundled Gitea is entered through the API alone; the controller writes it; SCP's own plugin path
  submits the shipped `scp-build-image-v1`; rootless BuildKit builds and pushes to the bundled
  Gitea's container registry; the image is listed there at the commit; and the token is absent from
  every row of every table, every scpd and controller log line, the audit rows and the backend pods'
  logs. The integration suite adds a real `pg_dump` scan (while pending and after delivery), the
  replay and redirect refusals against the real table, and the controller-only doors.
- **What the DoD does not prove.** The kind suite sets one deployment value in a copy of the chart —
  `buildImage.sourceHost` names the bundled Gitea — because the source forge is a deployment choice
  (D6), not a credential; making the bundled forge the default source is not this increment. Its
  scpd is not a pod (the wiring suite's reason). The infra Secrets and the workload-identity
  annotations are proved by the integration suite and the controller's unit suite, not by a real
  plan/apply or a real cloud (M29.7 runs the plan/apply). The envelope is not signed by scpd (§3).
- Credential Secrets are not part of a backend's render, so disabling or purging a backend leaves
  them; deleting a key goes through `scp stack credential delete`.
