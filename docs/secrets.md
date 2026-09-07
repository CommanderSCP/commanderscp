# secrets

Long-form reference for the **secrets** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 5 of 5 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/secrets/crypto.ts`](#apps-server-src-secrets-crypto-ts) — §1–§1
- [`apps/server/src/secrets/decrypt-canary.integration.test.ts`](#apps-server-src-secrets-decrypt-canary-integration-test-ts) — §2–§2
- [`apps/server/src/secrets/decrypt-canary.ts`](#apps-server-src-secrets-decrypt-canary-ts) — §3–§3
- [`apps/server/src/secrets/secrets-repo.ts`](#apps-server-src-secrets-secrets-repo-ts) — §4–§5

## `apps/server/src/secrets/crypto.ts`

### §1. AES-256-GCM envelope for the `secrets` table

AES-256-GCM envelope for the `secrets` table (db/schema.ts's M7 section doc comment). This is the encryption-at-rest layer `instance_keys` (M4/M6) explicitly opted out of — org-supplied plugin credentials (GitHub App private key, ArgoCD token, managed-IaC infra credentials) are a different trust tier: many tenants, arbitrary third-party secrets, injected into subprocess plugins, not just one federation-domain signing keypair `scp_app` alone ever touches.

Key management (honest, v1 scope — no KMS/vault integration, same "no external PKI" posture DESIGN §10.2 takes for attestation signing): the root key is a single 32-byte AES-256 key supplied by the operator via `SCP_SECRETS_MASTER_KEY` (base64), loaded once at boot (config.ts). `keyVersion` on every row is reserved for a future key-rotation scheme (re-encrypt under a new master key, bump the version, keep decrypting old rows under whichever version they were written with) — v1 always writes/reads version 1 and only ever has one active key in memory, but the column exists now so rotation is additive later, not a migration.

## `apps/server/src/secrets/decrypt-canary.integration.test.ts`

### §2. D6 / B3 boot canary

D6 / B3 boot canary (§7.3). The canary proves the configured master key decrypts the vault, per org, inside `withTenantTx` (the RLS-vacuity fix — an unscoped read would pass on a vault it never saw). These prove: the RIGHT key passes and actually decrypted something; the WRONG key fails closed; and an org with no vault is not a false failure.

## `apps/server/src/secrets/decrypt-canary.ts`

### §3. D6 / B3 BOOT CANARY

D6 / B3 BOOT CANARY (multi-region-instance-resilience.md §7.3). Proves the configured `SCP_SECRETS_MASTER_KEY` actually decrypts this instance's vault BEFORE serving — the failure mode it exists to catch is a member cluster (or a restored instance) booting with the WRONG master key, where every stored plugin credential is silently undecryptable and every executor call fails only later, one at a time, with no single loud signal.

SPECIFIED AGAINST RLS (the v0.1 canary "could never run"): `secrets` is FORCE-RLS, so an UNSCOPED `SELECT FROM secrets` returns zero rows *vacuously* and a canary written that way passes on a vault it never read. So this enumerates orgs on the un-RLS'd `orgs` table, then attempts exactly one decrypt PER ORG inside `withTenantTx` (which sets `app.current_org_id`, the only way the row is visible). A zero-row org is skipped — a genuinely empty vault is not a failure. `decryptSecretValue` throws on an AES-256-GCM auth-tag mismatch (a wrong key), which propagates out as the refusal.

The caller (main.ts, production mode only) treats a throw as fail-closed: refuse to serve.

## `apps/server/src/secrets/secrets-repo.ts`

### §4. CRUD over the encrypted `secrets` table

CRUD over the encrypted `secrets` table (db/schema.ts's M7 section, crypto.ts's AES-256-GCM envelope). Every read/write here is org-scoped through `TenantTx` (RLS-backed, same as every other tenant table) — there is no cross-org secret lookup path.

### §5. Resolves every `{configFieldName: secretKey}` ref in one call

Resolves every `{configFieldName: secretKey}` ref in one call (executor/notification bindings' `secretRefs` column) into `{configFieldName: plaintextValue}` — refs that don't resolve to an existing secret are silently omitted from the result (fail-soft here; the plugin itself decides whether a missing credential is fatal when it tries to use it, exactly like `SecretsAccessor` contract's `Promise<string | undefined>`).
