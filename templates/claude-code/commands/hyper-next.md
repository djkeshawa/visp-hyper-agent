---
description: Show the current visp-hyper action without granting strict progression.
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
independent only for a genuinely Kit-less local workflow and may be handed to
separate `implementer` dispatches there. Finish with
`visp-hyper checkpoint --task <id>` to collect local validation evidence.

Hyper checkpoint results are local evidence only.
Strict progression and remediation require the exact current ready Kit action.
In Kit-backed work, dispatch only that action and do not infer sibling permission
or a next step from a Hyper PASSED result.
