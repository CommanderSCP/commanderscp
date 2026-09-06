# ci-offline-mirror.test

Reference for `deploy/airgap/src/ci-offline-mirror.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 7 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE OFFLINE-CI GATE

THE OFFLINE-CI GATE — "everything, CI included, must run offline" as a CHECK, not a claim

Charter principle 5 and the working convention "Tests never touch the internet". CI was breaking both: `promotion-scan-step.integration.test.ts` pulled its scan subjects straight from Docker Hub, `oidc.integration.test.ts` pulled Keycloak from quay.io, and the two pinned-CLI installers `docker create`d out of quay.io/ghcr.io — all on the REQUIRED integration gate. Measured over ~31 days of history, ~13% of failing integration-shard jobs (3 of 23, on PR branches AND on `main`) were external-registry failures rather than anything to do with the code.

`tools/ci-mirror/images.list` is the census that closed it. This file is what stops the census from rotting — and it exists because the LAST attempt at this property was a comment. Job 5's env block asserted, in prose, that ryuk was "THE LAST UNMIRRORED DOCKER HUB PULL ON THE REQUIRED GATE'S PATH"; four classes of pull were open at the time, and stayed open for months behind that sentence. A well-written comment naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md, "census by property, not by symptom").

WHAT THIS PROVES, AND WHAT IT CANNOT — read `@scp/source-census`'s own module doc first
This is a SOURCE CENSUS: it reads the repo's own text and asserts what it still says. It proves a NECESSARY condition ("no file names an image the mirror does not carry"), never a sufficient one. It cannot see an image name assembled at runtime, one arriving through an env var this file does not know about, or a `docker pull` inside a shell script a test spawns.

THE RUNNING HALF IS THE `blackhole` STEP in workflow job 5: before the suite starts, every upstream registry this manifest mirrors is pointed at 127.0.0.1 in /etc/hosts. A pull this census cannot see still cannot succeed. Read the two together — the census says "you did not write it down", the blackhole says "and it would not have worked anyway".

NUL-BYTE NOTE: the walker below reads files through Node, which is why it sees all of them. Four source files in this repo contain NUL bytes, and plain `grep -r` skips those SILENTLY — printing nothing at all, not even "Binary file matches". A census run with `grep` (rather than `grep -a`) would report a clean sweep over a tree it never fully read.

## §2. Every `.ts` in the tree EXCEPT this file

Every `.ts` in the tree EXCEPT this file. A census that quotes the patterns it hunts for cannot be a subject of itself — the example refs in the assertion messages and doc comments above would be reported as real findings. This is the only exclusion, and it is the file doing the excluding; anything else earning one would be a filter, and a filter is where the next instance hides.

## §3. Read and comment-strip the whole tree ONCE

Read and comment-strip the whole tree ONCE. Three assertions below walk it, and doing the strip per assertion put this file over vitest's 5s default the moment the suite ran alongside its siblings rather than alone — a census that times out is a census that does not run.

## §4. THE VAR MUST ARRIVE, NOT MERELY BE EXPORTED

THE VAR MUST ARRIVE, NOT MERELY BE EXPORTED — the gap that took both shards red
`ci-mirror.sh seed` wrote `SCP_TEST_SUBJECT_REGISTRY` into $GITHUB_ENV, the workflow log showed it set on every later step, and the two subject suites read it with a `docker.io/library` fallback — and the suites still went to Docker Hub, because the suites do not run in the job's shell. They run under `turbo run test:integration`, and turbo's env mode is STRICT: a task receives only the vars named in its `env`/`passThroughEnv` plus a small system set. An undeclared var is not passed through empty, it is ABSENT — so `?? "docker.io/library"` took the fallback and the blackhole, working exactly as designed, denied it.

The existing assertion above ("the subject suites read the same env var ci-mirror.sh exports") passed throughout. It checked the producer and it checked the consumer; nothing checked the pipe between them. That is the shape this block exists to make impossible for the NEXT var: the repo had already paid for this lesson once — `SCP_RUNNER_*_IMAGE_REF` are in `passThroughEnv` for the same reason — and paying twice is what a census is supposed to prevent.
