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
# SUBSTITUTED IN PLACE, never re-serialized. `json.dump(indent=2)` rewrites the WHOLE document and
# always expands short arrays onto one line each, while prettier — which owns formatting for every
# file in this repo — collapses them. Re-serializing therefore made `pnpm format:check` fail every
# time a role was re-pinned, and "run prettier afterwards" is not a fix because the next re-pin
# undoes it. A digest is a 71-character literal; replacing just that literal leaves every other byte
# of the file exactly as the formatter left it.
text = open(path, encoding="utf-8").read()
catalog = json.loads(text)
for role in catalog["roles"]:
    fresh = role_digest(os.path.join(catalog_dir, "roles", role["name"]))
    current = role["digest"]
    if fresh == current:
        continue
    # Digests are content hashes of distinct directories, so a stale one appears exactly once. The
    # count is asserted rather than assumed: a silent zero-replacement would leave the catalog stale
    # while this script reported success, which is the failure the digest gate exists to catch.
    if text.count(current) != 1:
        raise SystemExit(
            f"refusing to re-pin '{role['name']}': its current digest appears "
            f"{text.count(current)} times in catalog.json, not once"
        )
    text = text.replace(current, fresh, 1)
with open(path, "w", encoding="utf-8") as fh:
    fh.write(text)
print(f"pinned {len(catalog['roles'])} role digests")
