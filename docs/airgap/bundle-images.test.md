# bundle-images.test

Reference for `deploy/airgap/src/bundle-images.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 14 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE WIRING PROOF

THE WIRING PROOF. Everything above tests the LIST; this RUNS the entrypoint and reads the list it actually resolved. A `bundle-images.ts` that names all three runners while `build-bundle.ts` keeps a hardcoded array of its own is precisely the "component built, never installed" defect this repo keeps shipping, and only running the entrypoint can rule it out.

IT RUNS `src/build-bundle.ts` UNDER tsx — NOT `dist/build-bundle.js`, which is what it used to do and which made the proof only as fresh as the last `tsc`. Under the exact command this package's README documents (`pnpm --filter @scp/airgap test` — vitest directly, NOT through turbo, so `dependsOn: ["build"]` never runs), a stale `dist/` passed while the source was broken: reverting `resolveImageSources` to a hardcoded three-image array and NOT rebuilding left this suite green. A wiring proof that can pass against a build nobody just made is not a proof of anything. Nothing is given up by driving the source: `dist/build-bundle.js` is `tsc` output of this exact file and of nothing else, and the `build`/`typecheck` tasks cover that compile step.

## §2. The M21.7 class, INVERTED

The M21.7 class, INVERTED. Above: an image the bundle carries that install.sh cannot address. Here: an image install.sh addresses that the bundle does not carry — the same disagreement from the other side, and the one that fails at 3am on a disconnected cluster with `SCP_RUNNER_X_DIGEST: unbound variable` under `set -u`.

install.sh's verify/push loops are generic over `$BUNDLE_IMAGE_NAMES`, but its step-4 helm wiring necessarily names stems literally (each maps to a different chart value or env var). Those literals are read OUT OF THE REAL SCRIPT here rather than restated, so a stem added to install.sh without an image behind it fails on its first run.

## §3. VERIFY THE LEVER, NOT JUST THE SIGNAL

VERIFY THE LEVER, NOT JUST THE SIGNAL. The compose-mode instruction is only real if the product reads that env var. All three managed classes read theirs in one module — deliberately the only place this looks, and deliberately named in `turbo.json`'s inputs for this package, so the two stay in step: move the read and this fails loudly rather than going quietly stale.
