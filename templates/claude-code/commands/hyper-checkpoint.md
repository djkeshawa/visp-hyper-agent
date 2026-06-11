---
description: Checkpoint the active visp-hyper task and report the outcome.
---

Run the following via Bash (pass a task id in $ARGUMENTS, or run it bare to
checkpoint the active task):

```
visp-hyper checkpoint --task $ARGUMENTS
```

Report the verify/review outcome. On a FAILED result, fix ONLY the reported
findings — do not expand scope — then re-run the checkpoint.
