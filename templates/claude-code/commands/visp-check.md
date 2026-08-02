---
description: Run the real checks and record evidence without changing any workflow state.
---

Run the following via Bash:

```
visp check
```

A pass here moves nothing: no checklist tick, no status advance.
Hyper checkpoint results are local evidence only.
Strict progression and remediation require the exact current ready Kit action. Use `/visp-handoff` when the evidence should count.
