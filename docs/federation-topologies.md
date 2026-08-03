# Federation topologies — when one commander is enough, and when it is not

**Status:** Guidance, 2026-08-03. Owner-decided direction; not an ADR (it settles no new model, it explains an existing one).
**Relates to:** [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) (the roles); [ADR-0001](adr/0001-in-app-federation-mtls.md) (the trust material); [GLOSSARY.md](GLOSSARY.md) (**outpost** = the federation role for a per-domain/per-environment *instance*); charter principle 7 (Simplicity outranks Federation).

## One commander coordinating several places is a real topology, not a half-built one

An **outpost** is not a lightweight agent. It is the federation role of a whole running instance — its own deployment, its own PostgreSQL, its own trust material. So "no outposts" is a valid answer to "what does my federation look like", not a setup step you skipped.

The UI says this rather than showing an empty table: the Outposts page renders **this domain** as its own panel, then states that no *other* peers are paired. If you have one instance, that is the complete and correct picture.

**Default to one commander.** Charter principle 7 orders the trade-offs *Simplicity → Extensibility → Federation → …*, and federation sits below simplicity deliberately. A single commander can coordinate execution systems in as many clusters as it can reach, and for a user who will never have more than one remote environment, most of what federation offers — cross-domain promotion, the CDS boundary, retrans relaying — is inapplicable. Standing up a second instance to use none of it is cost without return.

## What actually decides it

Not elegance, and not (yet) availability. Two things:

### 1. Credential locality — the one that decides most cases

`scp connect` stores the execution system's token **in the instance you ran it against**. So with a single commander, the credential for every system it coordinates lives at the commander.

That is fine when the commander is *at least as protected as the systems it controls*. It stops being fine when it is not — a production credential held by a less-protected instance is a real exposure, and no amount of network policy fixes it, because the credential is the reach.

An outpost inverts this: the credential lives in the domain it controls, and the commander never holds it.

> **Worked example.** A homelab commander coordinating a hosted production cluster ends up holding that cluster's Argo CD token in the homelab. The coordination works perfectly; the credential is in the wrong place. That is the outpost's argument, and it is a security argument rather than an architectural one.

### 2. Reach direction

A single commander reaches **into** each system it coordinates — which needs egress from the commander, an entry in its SSRF allowlist, and a network path that the remote side must accept.

Federation is **outpost-initiated**: the outpost dials out to the commander and the commander never dials in. For an environment whose policy is "accepts no inbound coordination traffic", that is not an optimisation — it is the only shape that works, and it is why the air-gap/CDS designs are built the way they are.

## What is NOT a good reason yet

**Surviving a commander outage.** This is the reason people reach for first, and it is weaker than it sounds today. It only pays if the outpost can release *on its own* while the commander is unreachable. That works by construction — a domain-local change targets no peer, so it never needs export — but the named, tested form of it is a deferred capability ([ADR-0018](adr/0018-domain-local-dev-pipelines.md)). Do not choose an outpost for autonomy until that is warrantied; choose it for credential locality, which is true now.

## What an outpost actually costs

The container is the cheapest part.

| | |
|---|---|
| **the instance** | the *same* Helm chart with `federationRole: outpost`; can run as a single pod (`SCP_ROLE=all`) |
| **a database** | its own PostgreSQL (principle 4). The chart's in-cluster Postgres is marked EVALUATION ONLY, so a production outpost wants a managed one |
| **trust material** | mutual TLS both ways — `federation.mtls` (the client cert the outpost presents) and `federation.serverMtls` (the commander's own CA/cert/key/CRL). A CA, two certs, and a rotation plan |
| **pairing** | peer registration on both sides, plus the journal signing keys the hash-chained exchange chains over |

So: **one pod, one database, a handful of certs** — and an ongoing operation (sync, key rotation) rather than a one-time install.

## The rule of thumb

> Use one commander until the remote place is more sensitive than where your commander lives. When it is, the outpost is not buying elegance — it is buying you not storing that environment's credentials somewhere less protected than the environment itself.
