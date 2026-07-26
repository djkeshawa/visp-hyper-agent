---
name: visp-hyper
description: Follow Visp Hyper's current handoff and canonical Kit action for scoped implementation.
---

# Visp Hyper workflow

1. Run `visp-hyper run "<goal>"`.
2. Read every required file and resource in the handoff.
3. When assurance is `kit_strict`, treat the rendered Kit action as authoritative.
4. Stay inside writable scope and never edit a forbidden path.
5. Use read-only scout, verifier, or challenger subagents only for bounded work.
6. Run only the action's validation commands, then record local evidence with
   `visp-hyper checkpoint --task <id>`.
7. Treat Kit-less results as `local_checked`, never Kit approval.
8. Record bounded learnings with `visp-hyper remember`; remembering does not
   complete a Kit task.
