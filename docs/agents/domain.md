# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## This repo's layout: single-context

One `CONTEXT.md` at the repo root plus `docs/adr/` cover the whole repo. There is **no**
`CONTEXT-MAP.md` and no per-subproject `CONTEXT.md` — this repo is a single plugin with one domain
vocabulary, so a context map would add a layer with nothing to put in it.

`pnpm-workspace.yaml` exists but is not a monorepo signal: it declares `packages: ['.']` only, to keep
the dependency store local to this checkout. There is no `packages/` directory.

Neither `CONTEXT.md` nor `docs/adr/` exists yet. They are created **lazily**, on the first glossary
term or architectural decision that actually gets resolved, by the `/domain-modeling` skill (reached
via `/grill-with-docs` and `/improve-codebase-architecture`). Do not create them upfront, and do not
treat their absence as a problem.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront.

## File structure

This repo (single-context):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

A multi-context repo would instead have `CONTEXT-MAP.md` at the root pointing at one `CONTEXT.md` and
`docs/adr/` per context (`src/<context>/CONTEXT.md`). This repo is not that, and switching layouts is
a deliberate decision, not something to drift into.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
