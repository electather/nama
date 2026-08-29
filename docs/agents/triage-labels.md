# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (for example, "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Capability labels

`requires:xcode` is a hard scheduling requirement for implementation that owns
Apple/Xcode paths. Apply it during triage; the local issue executor never adds it
after work starts. A runner must declare `--capability xcode` and independently
verify a repository-compatible Xcode and SDK before claiming the issue.

Physical Apple-device acceptance, security decisions, and unresolved product
design remain `ready-for-human`. Split independently verifiable implementation
from physical acceptance when doing so preserves the original acceptance
criteria.

Edit the right-hand column to match whatever vocabulary you actually use.
