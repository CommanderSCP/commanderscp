#!/usr/bin/env python3
"""Delete every Ansible module / lookup plugin / action plugin not named in allowlist.json.

ADR-0050: the lockdown is DELETION, not configuration. `ANSIBLE_CONFIG`, a cwd `ansible.cfg` and
per-play settings all compete for control of what a play may load, but a plugin file that is not
present in the image cannot be loaded by any configuration an attacker can reach. This script is
therefore the actual security control; `ansible.cfg` beside it is defence in depth.

Runs at BUILD time and fails the build loudly if anything is inconsistent — an allowlist entry that
does not exist upstream means the allowlist is stale (usually an `ansible-core` bump that renamed or
removed something), and silently tolerating it would leave a class the catalog needs missing at run
time instead.
"""
import json
import os
import sys
import glob

import ansible

ROOT = os.path.dirname(ansible.__file__)
allow = json.load(open(sys.argv[1]))

modules = sorted(
    sum((v for k, v in allow["modules"].items() if not k.startswith("$")), [])
)
groups = {
    "modules": (os.path.join(ROOT, "modules"), set(modules)),
    "plugins/lookup": (os.path.join(ROOT, "plugins/lookup"), set(allow["lookup"]["allowed"])),
    "plugins/action": (os.path.join(ROOT, "plugins/action"), set(allow["action"]["allowed"])),
}

failed = False
for label, (directory, keep) in groups.items():
    present = {
        os.path.basename(f)[:-3]
        for f in glob.glob(os.path.join(directory, "*.py"))
        if not f.endswith("__init__.py")
    }
    # A stale allowlist is a build failure, never a silent no-op: the catalog would be missing a
    # capability it declares, and the set-equality test downstream would then pass against a set
    # that is wrong in the same direction.
    stale = keep - present
    if stale:
        print(f"prune: {label}: allowlist names {sorted(stale)}, absent upstream", file=sys.stderr)
        failed = True
    for name in sorted(present - keep):
        os.remove(os.path.join(directory, f"{name}.py"))
    print(f"prune: {label}: kept {len(keep & present)}, deleted {len(present - keep)}")

if failed:
    sys.exit(1)
