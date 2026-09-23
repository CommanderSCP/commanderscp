#!/usr/bin/env python3
"""Recompute each role's content digest and write it into catalog.json.

Run after editing any role, then re-sign catalog.json. `catalog-digests.test.ts` fails if the
pinned digests are stale, so "edited a role and forgot to re-pin" is caught in CI rather than at
run time on a host.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify_catalog_digests import role_digest  # noqa: E402  (shares ONE digest definition)

catalog_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog")
path = os.path.join(catalog_dir, "catalog.json")
catalog = json.load(open(path))
for role in catalog["roles"]:
    role["digest"] = role_digest(os.path.join(catalog_dir, "roles", role["name"]))
with open(path, "w") as fh:
    json.dump(catalog, fh, indent=2)
    fh.write("\n")
print(f"pinned {len(catalog['roles'])} role digests")
