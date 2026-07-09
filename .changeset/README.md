# Changesets

This directory holds changeset files consumed by `@changesets/cli`. `@scp/plugin-api` and
`@scp/sdk` carry independent semver in this repo (DESIGN.md §3); other packages are internal to
the monorepo and versioned together.

When you make a change to `@scp/plugin-api` or `@scp/sdk` that should ship a release, run:

```bash
pnpm changeset
```

and follow the prompts. See https://github.com/changesets/changesets for full docs.
