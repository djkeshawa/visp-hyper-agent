---
description: Install and verify the matched Visp pair and host registration (machine scope).
---

Run the following via Bash:

```
visp setup
```

Setup is machine scope. If it refuses because the Visp Dev adapter is missing, install it with `npm install -g visp-dev` and re-run.

If that install is not available to you, setup is not the only way in. Two commands, and both are needed:

```
visp-kit init .
visp init
```

`visp-kit init .` sets up Kit; `visp init` writes the Visp Hyper config and state. Kit's step alone leaves `visp doctor` reporting `Visp Hyper has not been initialized in this project`. Run `visp doctor` afterwards to confirm `Overall: PASS`.

Prefer `visp setup` when it can run — it does both of these and also registers the host and configures memory.
