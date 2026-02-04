# Agent Instructions

## Changesets (Versioning & Publishing)

This monorepo uses [Changesets](https://github.com/changesets/changesets) to manage package versions and npm publishing. **Do not manually edit `version` fields in any `package.json`** -- Changesets handles that automatically.

### When to create a changeset

Create a changeset whenever you modify code inside `packages/*` that should result in a new published version. This includes bug fixes, new features, and breaking changes. Do **not** create changesets for changes that don't affect published packages (e.g. CI config, docs-only changes, test-only changes).

### How to create a changeset

Since interactive prompts don't work in agent environments, create the changeset file directly. The file goes in `.changeset/` and must have:

1. A random filename ending in `.md` (e.g. `.changeset/cool-birds-fly.md`)
2. YAML frontmatter listing each affected package and its bump type
3. A short description of the change

Example:

```markdown
---
"@tayacrystals/shard-sdk": minor
"@tayacrystals/shard": patch
---

Add new tool registration API to the SDK.
```

### Choosing the bump type

- **patch** (`0.0.x`): Bug fixes, internal refactors that don't change the public API
- **minor** (`0.x.0`): New features, non-breaking additions to the public API
- **major** (`x.0.0`): Breaking changes to the public API

If you change `@tayacrystals/shard-sdk` and other packages depend on it (core, model-openaigeneric, model-googleai), Changesets will automatically bump those dependents -- you only need to list packages you directly modified.

Keep in mind that all packages should have the same major version number, so a major bump to one package will cause all packages to get a major bump. So users can easily keep track what packages are compatible with each other.

Also keep in mind that whilst we still are in `0.x.y` versioning, minor version bumps may include breaking changes as we stabilize the API.

### Package names

- `@tayacrystals/shard-sdk` -- SDK (packages/sdk)
- `@tayacrystals/shard` -- Core (packages/core)
- `@tayacrystals/shard-model-openaigeneric` -- OpenAI-generic model provider (packages/model-openaigeneric)
- `@tayacrystals/shard-model-googleai` -- Google AI model provider (packages/model-googleai)

### What happens after merge

When a PR with changeset files merges to `main`, CI automatically opens a "Version Packages" PR that bumps versions and generates changelogs. Merging that PR triggers the actual npm publish.
