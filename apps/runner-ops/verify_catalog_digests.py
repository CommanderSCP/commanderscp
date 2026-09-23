#!/usr/bin/env python3
"""Check every catalog role against the digest catalog.json pins for it.

WHY THIS EXISTS SEPARATELY FROM THE SIGNATURE. cosign signs `catalog.json` — a few hundred bytes of
manifest. It says nothing about `roles/**`, so an attacker able to write into the catalog directory
could leave the signed manifest untouched and rewrite a role's tasks. Pinning each role's content
digest in the signed manifest, and checking it here, extends the signature's reach to the bytes
that actually execute.

Importable: `pin_catalog_digests.py` reuses `role_digest` so the digest is defined exactly once. A
second definition that drifted would make the pinner and the verifier disagree, which fails closed
but for a reason nobody could find.
"""
import hashlib
import json
import os
import sys


def role_digest(role_dir: str) -> str:
    """Content digest over a role: every file, path-sorted, path AND bytes both hashed.

    Paths are hashed too, so RENAMING a file — moving tasks into a differently-named file the
    loader also reads — changes the digest. Hashing contents alone would not catch that.
    """
    h = hashlib.sha256()
    for root, _dirs, files in sorted(os.walk(role_dir)):
        for name in sorted(files):
            full = os.path.join(root, name)
            h.update(os.path.relpath(full, role_dir).encode())
            h.update(b"\0")
            with open(full, "rb") as fh:
                h.update(fh.read())
            h.update(b"\0")
    return "sha256:" + h.hexdigest()


def main() -> int:
    catalog_dir = sys.argv[1]
    with open(os.path.join(catalog_dir, "catalog.json")) as fh:
        catalog = json.load(fh)
    failed = False
    for role in catalog["roles"]:
        pinned = role.get("digest")
        name = role["name"]
        if not pinned:
            print(f"verify_catalog_digests: role {name!r} has no pinned digest", file=sys.stderr)
            failed = True
            continue
        actual = role_digest(os.path.join(catalog_dir, "roles", name))
        if actual != pinned:
            print(
                f"verify_catalog_digests: role {name!r} is {actual}, manifest pins {pinned}",
                file=sys.stderr,
            )
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
