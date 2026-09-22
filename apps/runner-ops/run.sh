#!/bin/sh
# scp-runner-ops run shim. Single-shot: validate what was handed in, run exactly one catalog play,
# exit. See apps/runner-ops/README.md.
#
# M27.1 ships the image and its lockdown gate. Catalog execution (M27.3), unsafe-marked parameters
# (M27.2) and credential provisioning (M27.4/M27.5) attach here in their own increments; this shim
# deliberately REFUSES rather than pretending to run, so an image built today cannot be wired up
# and quietly do the wrong thing.
set -eu

if [ "${1:-}" = "--lockdown-inventory" ]; then
  # The gate's read path (lockdown.test.ts). Emits the module/lookup/action surface actually present
  # in this image, so the assertion is made against the BUILT ARTIFACT rather than against the
  # Dockerfile's intent.
  exec python - <<'PY'
import ansible, os, glob, json
p = os.path.dirname(ansible.__file__)
def names(sub):
    return sorted(
        os.path.basename(f)[:-3]
        for f in glob.glob(os.path.join(p, sub, "*.py"))
        if not f.endswith("__init__.py")
    )
print(json.dumps({
    "modules": names("modules"),
    "lookup": names("plugins/lookup"),
    "action": names("plugins/action"),
}))
PY
fi

echo "scp-runner-ops: no catalog is wired yet (M27.3). Refusing to run." >&2
exit 2
