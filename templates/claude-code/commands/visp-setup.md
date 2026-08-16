---
description: Install and verify the matched Visp pair and host registration (machine scope).
---

Run the following via Bash:

```
visp setup
```

Setup is machine scope. If it refuses because the Visp Dev adapter is missing, install it with `npm install -g visp-dev` and re-run.

If that install is not available to you, setup is not the only way in: `visp-kit init .` sets the project up on its own, with no machine-scope step. Prefer `visp setup` when it can run — it also registers the host and configures memory — but the project-scope route is never a dead end.
