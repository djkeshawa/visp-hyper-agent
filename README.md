# Visp Hyper Agent

**Runs the Visp workflow inside the AI coding tool you already use.**

Visp Kit decides what is allowed and what counts as proof. Hyper is the part
that sits inside Codex, Claude Code, GitHub Copilot, or OpenCode and actually
drives that workflow — preparing each task, handing the agent only the context
it needs, and recording what happened.

**It never calls an LLM itself.** Your coding tool does the thinking; Hyper
handles scope, sequencing, and evidence.

---

## Install

```bash
npm install -g visp-hyper-agent
```

Requires Node 22 or later, Git, and [`visp-kit`](https://www.npmjs.com/package/visp-kit).

## First run

```bash
visp-hyper init --project .
```

`init` detects which AI coding tool you use and installs the right integration
for it. It sets up files; it does not install packages for you.

```bash
visp-hyper next
```

Shows the single next action, already scoped to the current task.

```bash
visp-hyper checkpoint --task T001
```

Records evidence for a task. **If the work does not meet the gate, this fails**
— which is the point.

## What it does

| | |
|---|---|
| **Scoped handoffs** | The agent receives one task and the files it may touch, not your whole repository. |
| **Enforces Kit's gates** | Hyper coordinates; Kit decides. A Hyper checkpoint never grants permission Kit withheld. |
| **Local evidence** | Checkpoints are files under `.visp/`. Nothing is uploaded. |
| **Host-aware setup** | Reads a versioned manifest per tool, so it installs only what that tool actually supports. |
| **Skill harvesting** | Turns techniques your agent works out mid-session into reusable project skills. |

## Honest limits

- **No productivity claim.** Whether this makes teams faster or produces better
  software is **unmeasured**. Any claim otherwise is a bug — please report it.
- **Kit and Hyper are compatible in tested pairs**, pinned to exact commits. Do
  not assume any two versions work together.
- **Durable shared memory is not available yet.** File-based memory is the
  default. The legacy HTTP memory mode exists only for private migrations
  already using it.
- **Conformance is partial**, and non-Linux systems are not yet covered.

## Where to get help

- **Source, issues, and pull requests:**
  [visp-hyper-agent](https://github.com/djkeshawa/visp-hyper-agent)
- **Compatibility evidence and conformance reports:**
  [visp-dev](https://github.com/djkeshawa/visp-dev)
- **Security issues:** see `SECURITY.md`. Do not open a public issue.
- **Contributing:** see `CONTRIBUTING.md`.

---

**New here? Follow the [five-minute quickstart](docs/quickstart.md) to see a commit get blocked and a task verified.**

## How it works

Visp Hyper **does not call** an LLM. Your coding tool does the thinking; Hyper
decides what it is allowed to work on and records what happened.

Everything is files under `.visp/` in your project. No database, no uploads.

Kit decides; Hyper coordinates. **A Hyper checkpoint can never grant permission
Kit withheld** — that separation is the point.

## Documentation

| | |
|---|---|
| [Commands](docs/commands.md) | Every command, and the output blocks it prints |
| [Cockpit](docs/cockpit.md) | Read-only local artifact screens, provenance, and transport boundaries |
| [Working inside an agent](docs/workflows.md) | A full Claude Code session, skill harvesting, model routing |
| [MCP server](docs/mcp.md) | Exposing Hyper over MCP |
| [Configuration](docs/configuration.md) | File layout, memory modes, current limits |
| [Development](docs/development.md) | Building locally |

## License

Apache-2.0. See [LICENSE](LICENSE).
