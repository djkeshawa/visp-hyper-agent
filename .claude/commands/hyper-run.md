---
description: Start a visp-hyper session for a goal and follow the printed handoff.
---

Run the following via Bash:

```
visp-hyper run "$ARGUMENTS"
```

Then READ the printed handoff and action block and follow them exactly:

1. Read every file the handoff marks as required.
2. Respect the allowed and forbidden file scopes — touch only what is allowed.
3. Run the validation commands the handoff lists, and confirm they pass.
4. Finish the session as instructed (checkpoint, review, or remember).

If a BLOCKED block prints instead of a handoff, do NOT start coding — run the
named next command it tells you to run.
