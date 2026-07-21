---
description: Collect local checkpoint evidence for the active visp-hyper task.
---

Run the following via Bash (pass `--task <id>` and any other checkpoint flags in
$ARGUMENTS, or run it bare to checkpoint the active task):

```
visp-hyper checkpoint $ARGUMENTS
```

Report the verify/review outcome as local evidence.

Hyper checkpoint results are local evidence only.
Strict progression and remediation require the exact current ready Kit action.
In a genuinely Kit-less workflow, a FAILED result may guide a local correction
inside the existing scope. In Kit-backed work, do not remediate or advance from
Hyper status alone; follow Kit's exact action and next command.
