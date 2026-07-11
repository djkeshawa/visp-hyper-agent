---
description: Advance the active visp-hyper session to the next step.
---

Run the following via Bash:

```
visp-hyper next
```

Then coordinate the printed action block exactly as in `/hyper-run` (see
`.claude/agents/coordinator.md`): delegate the scout pass to the `scout` subagent
to gather the required files and context, evaluate its findings, then delegate the
implement pass to the `implementer` subagent within the allowed scope. Run the
listed validation commands yourself before accepting the result. If the action
block prints a `may_run_concurrently_with:` line, those sibling task ids are
independent and may be handed to separate `implementer` dispatches. Finish with
`visp-hyper checkpoint --task <id>` and proceed only on PASSED.
