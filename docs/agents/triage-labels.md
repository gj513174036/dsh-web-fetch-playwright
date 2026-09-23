# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## State of these labels

The vocabulary is the default one — no overrides — and all five labels already exist on the tracker
(`gj513174036/dsh-web-fetch-playwright`), so `/triage` applies them rather than creating duplicates.
`wontfix` pre-dates this setup with the description "This will not be worked on"; the label string,
which is what the skills match on, is the canonical one.

The other label family the skills use — `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling`, `wayfinder:task` — is documented in `issue-tracker.md` under _Wayfinding
operations_. Together they are the ten labels this repo's tracker carries for the skills.
