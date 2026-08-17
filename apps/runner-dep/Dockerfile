# syntax=docker/dockerfile:1.7
#
# scp-runner-dep — the SEPARATE image the `scp-managed-dep` executor launches per bump (charter's
# Managed Execution Exception, `scp-managed-dep` amendment approved 2026-08-13 and qualified
# 2026-08-15; ADR-0032 §8; BUILD_AND_TEST.md §8 M21.5). It mirrors apps/runner-iac and
# apps/runner-scan EXACTLY in shape: a pinned base + a minimal run shim, NOTHING else. No Node app
# code lives here (docs/DESIGN.md §3) — `packages/plugins/managed-dep` is the thin ORCHESTRATOR
# (it holds the per-run repository-write credential and reaches the git host); this image is the
# ISOLATED EDITOR it launches, and it reaches nothing at all.
#
# `docker build -t scp-runner-dep:dev apps/runner-dep` is the only build command for this image.
#
# ============================================================================================
# THE FOUR CHARTER CLAUSES THIS IMAGE *IS* THE ENFORCEMENT OF
# ============================================================================================
# Until this image existed, four clauses of the `scp-managed-dep` amendment were asserted in code
# comments and delegated to an artifact that was not built. They are properties of the IMAGE, and
# each one is a thing that is absent from it rather than a thing this shim declines to do:
#
#   "never runs a package manager"                     — there is no npm, yarn, pnpm, pip, mvn,
#   "never resolves or regenerates a lockfile"           gradle, go, cargo, bundler or nuget in this
#   "never builds, compiles, or tests"                   image, and no compiler, and no language
#   "the runner contains no package manager"             runtime to host one.
#
# THE FINAL STAGE IS `scratch`, AND THAT IS THE ANSWER TO THE FOURTH CLAUSE RATHER THAN A FLOURISH.
# The obvious build — `FROM busybox` plus the shim — does NOT satisfy it, and the fact is measured
# rather than argued: a stock BusyBox ships `dpkg` and `rpm` as applets (along with `wget`, `nc`,
# `telnet`, `ftpget` and some four hundred others), so "the runner contains no package manager" was
# FALSE of it. `runner-image.integration.test.ts` found that on its first run, which is precisely
# what a test that reads the Dockerfile's text cannot do.
#
# So the runtime image is assembled instead of inherited: stage one takes the digest-pinned BusyBox,
# copies out the ONE static multi-call binary, and creates symlinks for exactly the seven applets
# `run.sh` invokes; stage two is `scratch` and receives only that tree. The result contains one
# executable file and seven names, all of them enumerated below and asserted against the BUILT IMAGE.
#
# THE RESIDUAL, STATED RATHER THAN PAPERED OVER: BusyBox is a MULTI-CALL binary, so the code behind
# `dpkg`/`rpm`/`wget` is still inside `/bin/busybox` and `/bin/busybox dpkg` would still dispatch to
# it. Removing that needs a custom-compiled BusyBox, which means a C toolchain in the build — a
# strictly worse trade for this image. What the clauses are actually about is unaffected either way:
# the container is launched `--network none` unconditionally, so nothing can be fetched; the only
# bytes present are the ONE manifest copied in; and none of the five ecosystems this class authors
# (go, oci, npm, python, maven) is dpkg or rpm, so no lockfile could be resolved by any of it. What
# stage two removes is every ACCIDENTAL route to those applets, which is what a name is.
#
# TWO tests assert all of this, at two different altitudes, and the second is the one that can
# actually answer the question. `packages/plugins/managed-dep/src/runner-image.test.ts` reads THIS
# FILE (and the shim) — cheap, runs everywhere, and structurally blind to what the BASE brought in.
# `runner-image.integration.test.ts` BUILDS the image and asks the artifact: it runs the container
# and refuses if a package manager, compiler or language runtime is on its PATH or in its filesystem.
# The clauses are about what the runner CONTAINS, and only the built image can answer that.
#
# ============================================================================================
# NO NETWORK, NO CREDENTIAL, NO MOUNT — AND WHY AN EDITOR NEEDS NONE OF THEM
# ============================================================================================
# The 2026-08-15 amendment: "Runner network egress is `--network none`; the runner holds no
# credential, contains no package manager, and edits only the bytes handed to it. The orchestrator
# holds the per-run, repository-scoped, short-lived credential and reaches the git provider on the
# runner's behalf". Unlike `scp-managed-scan`, that clause carries NO registry-pull qualifier — so
# `--network none` is unconditional, and the orchestrator enforces it as a literal rather than as a
# configurable default (see `packages/plugins/managed-dep/src/index.ts`'s `runEditorContainer`).
#
# The bytes arrive by `docker cp` into /work/in and leave by `docker cp` out of /work/out. There is
# no bind mount and no docker socket, so a host-path escape is structurally impossible; there is no
# environment beyond argv, so there is nothing for a credential to be in.
#
# ============================================================================================
# OFFLINE AT BUILD TIME TOO (charter principle 5)
# ============================================================================================
# There is no `RUN` that installs anything: the base image is the whole toolchain, so this build
# needs exactly one pinned base and no package repository, no module proxy and no registry index.
# That is a stronger air-gap posture than either sibling runner, and it is the direct consequence
# of the class being manifest-only: an editor that must never resolve a dependency graph has no
# data to vendor. (The comparison with the sibling runners' toolchains is in README.md — naming
# them here trips `managed-scan`'s ADR-0020 containment gate, which flags a scanner named anywhere
# in a Dockerfile INCLUDING a comment, deliberately: "the only reason to mention a scanner in a
# Dockerfile is to put one in the image". This file is a genuine exception to that premise, and
# prose is the wrong place to spend the gate's precision.)
#
# ============================================================================================
# THE BASE IS A DIGEST, AND IT IS A LITERAL — NOT A TAG, AND NOT A BUILD ARG
# ============================================================================================
# `tools/busybox/pin.env` is the single source of truth (BUSYBOX_PINNED_IMAGE), exactly as the
# sibling runners' own `tools/*/pin.env` files are for them;
# `packages/plugins/managed-dep/src/runner-image.test.ts` fails if this line drifts from that file.
# The multi-arch INDEX digest is pinned rather than a platform digest so it resolves per build-host
# architecture — the same deviation, for the same reason, as both sibling runners' pins.
#
# WHY NOT A BUILD ARG WITH A DIGEST DEFAULT, which is the shape scp-runner-scan uses. Because that
# shape was measured here and it does not hold: `docker build --build-arg
# RUNNER_DEP_BASE_IMAGE=node:22 apps/runner-dep` produced an image TAGGED AS THE VETTED RUNNER
# carrying a full Node toolchain — every one of the four clauses above false — and the test that
# claimed to pin the base read this file's TEXT, so it stayed green. The clauses are not overridable,
# therefore the base is not a parameter. (scp-runner-scan needs its ARGs because a global build arg
# is how a value reaches a multi-stage `FROM`; this image has one stage and needs no such indirection.)
#
# A tag would be wrong for a second, independent reason: `busybox:1.36.1-musl` is MUTABLE — Docker
# Hub republishes maintenance rebuilds under it — and every clause this image enforces is a statement
# about what it CONTAINS, which a mutable tag makes a statement about whatever was served that day.
FROM busybox@sha256:3c6ae8008e2c2eedd141725c30b20d9c36b026eb796688f88205845ef17aa213 AS assemble

# THE WHOLE RUNTIME FILESYSTEM, ASSEMBLED BY HAND — one binary, seven names, two directories.
#
# The seven applets are EXACTLY the commands `run.sh` invokes, and nothing is here "in case". Adding
# an eighth is a deliberate edit that fails `runner-image.integration.test.ts`'s positive assertion
# until the list there is updated too, which is the point: the set of things this container can run
# is a reviewed list rather than whatever a base image happened to ship.
#
#   sh   — the shim's interpreter (its `#!/bin/sh`)
#   awk  — the edit itself; the only non-trivial thing in the shim
#   tail — reads the input's last byte, to detect a trailing newline
#   wc   — the byte count used to restore that byte shape
#   head — truncates the awk output by one byte when the input had no trailing newline
#   rm   — removes the temp file on the no-trailing-newline path
#   mv   — puts the temp file in place otherwise
#
# /work/in holds the ONE manifest the orchestrator `docker cp`'d in; /work/out is where the edited
# copy is written and `docker cp`'d back out. Created at BUILD time so the copy-in cannot be the
# thing that creates them (a missing directory would otherwise make `docker cp` write a FILE at
# /work/in, and the shim would read a directory).
COPY run.sh /rootfs/run.sh
RUN set -eu; \
    mkdir -p /rootfs/bin /rootfs/work/in /rootfs/work/out; \
    cp /bin/busybox /rootfs/bin/busybox; \
    for applet in sh awk tail wc head rm mv; do ln -s busybox "/rootfs/bin/$applet"; done; \
    chmod +x /rootfs/run.sh; \
    # FAIL THE BUILD, not a test six weeks later. Asserted as a COUNT rather than as a list of
    # forbidden names — the binary plus exactly seven symlinks — because a count cannot be satisfied
    # by a name nobody thought to forbid, which is the whole failure mode this image had.
    entries=$(ls -1 /rootfs/bin | wc -l); \
    [ "$entries" -eq 8 ] || { \
      echo "scp-runner-dep: /bin must hold exactly busybox + 7 applets, found $entries" >&2; \
      exit 1; \
    }

# ---------------------------------------------------------------------------------------------
# THE RUNTIME IMAGE — nothing is inherited, so nothing is inherited by accident.
# ---------------------------------------------------------------------------------------------
FROM scratch

COPY --from=assemble /rootfs/ /

# `scratch` has no default PATH, and the shim calls its applets by bare name.
ENV PATH=/bin

WORKDIR /work
ENTRYPOINT ["/run.sh"]
