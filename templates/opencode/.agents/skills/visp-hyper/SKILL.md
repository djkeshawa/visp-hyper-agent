---
name: visp-hyper
description: Follow the current Visp Hyper handoff and canonical Kit action for scoped implementation.
---

# Visp Hyper workflow

1. Run `visp-hyper run "<goal>"`.
2. Read every required file and resource in the handoff.
3. Treat the rendered Kit action as authoritative when assurance is `kit_strict`.
4. Stay inside writable scope and never edit a forbidden path.
5. Run only the action's validation commands, then record local evidence with
   `visp-hyper checkpoint --task <id>`.
6. Treat Kit-less results as `local_checked`, never Kit approval.
7. Record bounded learnings with `visp-hyper remember`; remembering does not
   complete a Kit task.
