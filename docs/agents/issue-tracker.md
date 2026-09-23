# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on the **fork**, and every `gh` command must
name that repo explicitly. Use the `gh` CLI for all operations.

## Which repo — read this first

This clone has two remotes:

| remote | repo | role |
| --- | --- | --- |
| `origin` | `gj513174036/dsh-web-fetch-playwright` | **ours** — issues, specs and tickets live here |
| `upstream` | `chendefine/dsh-web-fetch-playwright` | someone else's repo — never file issues against it |

`gh` prefers `upstream` when resolving a fork, so a bare `gh issue list` would silently read — and a
bare `gh issue create` would silently write — the **upstream** repo. `gh repo set-default
gj513174036/dsh-web-fetch-playwright` has been run in this clone (`remote.origin.gh-resolved =
base`), which fixes bare `gh` commands; pass `-R gj513174036/dsh-web-fetch-playwright` anyway on
anything that writes, so a fresh clone or a changed remote cannot mis-file an issue.

GitHub turns Issues **off** on a new fork, which would leave the skills with no place to file
anything; `has_issues` has been set to `true` on this fork. If a future clone reports
`repository has disabled issues`, that setting is what to check
(`gh api repos/gj513174036/dsh-web-fetch-playwright -q .has_issues`).

## Conventions

All examples pass `-R` for the reason above.

- **Create an issue**: `gh issue create -R gj513174036/dsh-web-fetch-playwright --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R gj513174036/dsh-web-fetch-playwright --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list -R gj513174036/dsh-web-fetch-playwright --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R gj513174036/dsh-web-fetch-playwright --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R gj513174036/dsh-web-fetch-playwright --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R gj513174036/dsh-web-fetch-playwright --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## Labels in this repo

All ten labels the skills use already exist on the fork, with the palette the skills deck declares for
them: the five triage roles (see `triage-labels.md`) and the five wayfinder labels
(`wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
`wayfinder:task`). Verify with
`gh label list -R gj513174036/dsh-web-fetch-playwright --limit 200`.
