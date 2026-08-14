---
description: Record a checkpoint of the current work.
---

Run the following via Bash:

```
visp save --task $ARGUMENTS --input-tokens <N> --output-tokens <M>
```

Substitute the token counts your host reported for this task. They are recorded
to the cost ledger; omitting them records the task as cost-unavailable, and a
later save with real counts supersedes that row.

Hyper checkpoint results are local evidence only.
Strict progression and remediation require the exact current ready Kit action.
