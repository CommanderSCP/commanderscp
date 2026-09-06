# bump-dispatch

Reference for `apps/server/src/dependencies/bump-dispatch.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 17 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. A DECLARATION PINNED TWICE

A DECLARATION PINNED TWICE (ADR-0032 §8i). `alpine:3.19@sha256:…` in a Dockerfile and `{repository, tag, digest}` in a chart's values both name the release AND the bytes, and every container runtime resolves by the DIGEST when one is present — the tag is then a label. So an edit that moves the version text alone changes the manifest and not the image that runs: the pull request reads as an upgrade, delivers nothing, and leaves the file asserting one release in its tag and another's bytes in its digest.

NOT GUESSED AT, EITHER WAY. The digest for `head` is known — `dependency_lines.latest_digest`, written by the same poll that moved `latest_version` and never inherited across a version change (`line-head.ts`) — so the data for a correct two-token edit exists. What does not exist is a one-line edit that carries it in the SPLIT shape, and `verifyManifestBump`'s "exactly ONE line differs" is a charter-enforcing refusal that is not widened to a pair as a side effect of this. Refused with its own name, and the follow-up is `split-shape-image-bumps.md` §11.

ASKED BEFORE EDITABILITY, and the honest reason is narrower than it looks: EITHER order refuses the same set — a digest-pinned Dockerfile is a writable kind, so it reaches this check whichever side of it the allowlist question sits on. What the order decides is which reason the Decision CARRIES when both apply, and "your declaration pins bytes as well as a version" is a fact about the manifest the team owns, while "this build does not write that file kind" is a fact about SCP. The first is the one they can act on.

## §2. Run ONE queued job

Run ONE queued job. Exported so an integration test drives the exact function the worker runs.

PHASES, and the split is the one M21.4 §7c clause 2 already established: read in a transaction, do provider I/O OUTSIDE any transaction, write in a transaction. Holding an RLS-scoped pooled connection across a git round trip — against a 5s production `statement_timeout` and a bounded pool — is the failure both M21.4 ingresses are arranged to avoid, and a repository WRITE is a longer round trip than either of them.

## §3. AND THE BINDING MUST NAME THAT REPOSITORY

AND THE BINDING MUST NAME THAT REPOSITORY. `pickComponentGitBinding` sorts the component's git-provider bindings by id and takes the first, which for a component bound to two repositories is an arbitrary choice — so without this the credential and the repository path could both come from a binding that has nothing to do with the manifest being edited. `observedRepo` NULL is "the repository was not recorded" (drizzle/0063), not a disagreement, so it falls through to the binding exactly as before.

## §4. Register the capability's worker

Register the capability's worker. Returns nothing the caller has to remember to wire: the ROUTER is registered separately, by `events/domain-event-registry.ts` under `bumpDispatchRoleGuard` — this same guard, by import rather than by copy — and a refused guard contributes NO router, so an event is not even enqueued for a queue nothing will drain.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the same shape the version poll, the internal-release loop and the inbox loop use, and for the same reason: a process that merely skipped the work inside the handler would still hold a worker for a queue it will never act on.
