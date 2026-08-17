# Visp Hyper Agent

**Runs the Visp workflow inside the AI coding tool you already use.**

Visp Kit decides what is allowed and what counts as proof. Hyper is the part
that sits inside Codex, Claude Code, GitHub Copilot, or OpenCode and actually
drives that workflow — preparing each task, handing the agent only the context
it needs, and recording what happened.

**It never calls an LLM itself.** Your coding tool does the thinking; Hyper
handles scope, sequencing, and evidence.

**Nothing about what this does to your accuracy, speed or token cost has been
measured.** Before installing, read
[what is measured, and what is not](#what-is-measured-and-what-is-not).

---

## Install

```bash
npm install -g visp-hyper-agent
```

Requires Node 22 or later, Git, and [`visp-kit`](https://www.npmjs.com/package/visp-kit).

## Compatibility

This package is the Visp coordinator. It provides the `visp-hyper` command; it
decides nothing — Visp Kit is the engine.

- **With Kit:** compatibility is an **exact pair**, pinned by commit and
  artifact hash — never a version range. This package publishes no supported
  range for `visp-kit`, in its manifest or anywhere else, because the pinned
  evidence records no version strings to range over and a range would be a
  support claim nobody measured. For the verdict on the pair you have
  installed, run `visp-dev doctor`; to exercise it yourself, `pnpm
  test:pair:served` from a clone. Hyper drives Kit through either CLI
  identity, probing `visp-kit` first and falling back to `visp`, the name Kit
  used before the rename; override with the `VISP_KIT_BINARY` environment
  variable or the `kitBinary` field in `.visp/hyper/config.json`.
- **With Memory:** optional. `visp-hyper` works without visp-memory installed;
  memory-backed features refuse visibly when it is absent.
- **With Visp Dev:** not required for project work; machine setup and checks
  live there.

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

## What is measured, and what is not

Read this before installing. It is the section that should decide it.

**Nothing about this package's effect on your work has been measured.** Not
accuracy, not speed, not token cost. Visp Kit at least has a measured figure for
one line item and a preregistered accuracy trial that ran out of quota before it
could resolve anything. Hyper has neither. There is no retracted claim here
because there was never a claim: no study of Hyper's coordination has been
designed, let alone run. **If you find anything in this package implying
otherwise, that is a bug — please report it.**

What can be stated is what Hyper *does*, structurally. These are properties you
can check by running it, not results you have to take on trust:

- **It sequences.** Thirteen verbs, one vocabulary for humans (`visp <verb>`)
  and models (`visp_<verb>`). `new`, `plan` and `handoff` are composites: they
  ask Kit what is next and execute only the bare command Kit itself recommends,
  bounded by an allowlist. There is no copy of Kit's workflow order inside
  Hyper, deliberately.
- **It scopes the handoff.** The agent is given one task, the files it may
  touch, the acceptance criteria and the validation commands — not the
  repository.
- **When a composite stops, it says why.** A blocked `new` used to print
  `blocked — visp-kit clarify reported failure. Run it directly for detail.`
  while holding Kit's envelope, which already contained the validation errors,
  the feature path and the recovery command. It now reports what it is holding,
  and a stage that merely needs a human exits 0 with the next step rather than
  as a hard failure.
- **It records.** Checkpoints, telemetry and evidence are files under `.visp/`.
  Nothing is uploaded.

**What nobody has measured is whether any of that helps you.** Concretely,
these questions are all open:

- Does a scoped handoff produce better work than handing an agent the whole
  repository, or does it just produce narrower work?
- Does a composite that explains its own block actually save a round trip, or
  do people re-run the underlying command anyway? The defect above was found by
  using the tool on one 7,700-line project — that is a bug report, not evidence
  of benefit.
- Does the adaptation rule (a scoped remediation task after two consecutive
  checkpoint failures) recover the task or churn on it?
- Does the whole workflow cost more than the agent session it wraps? Almost
  certainly yes; by how much is unknown, and nobody has counted.

Sequencing and refusals are real and inspectable. That is not the same thing as
being useful, and this package does not have the evidence to say it is.

**How the Kit pairing is verified** — and why a green test suite here is not the
claim you might read it as — is in [pair verification](docs/pair-verification.md).

## Honest limits

- **Kit and Hyper are compatible in tested pairs**, pinned to exact commits and
  artifact hashes. Do not assume any two versions work together; there is no
  supported range, and this package deliberately declares none. The pair is
  verified by `pnpm test:pair:served`, which drives the Kit npm serves and
  fails rather than skips when it cannot. Every record on file so far was
  produced on one Linux developer machine: the CI job that runs the same check
  needs no secret and can be run by anyone, but no run of it has been observed
  yet.
- **Durable shared memory is not available yet.** File-based memory is the
  default where nothing else is present. A project that has already installed
  `visp-memory` and initialised a store starts in `llm-memory` mode instead, and
  `visp doctor` warns rather than passes when such a project is left on file
  memory. The legacy HTTP memory mode exists only for private migrations
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
| [Pair verification](docs/pair-verification.md) | How the Kit pairing is checked, on which surface, and what is still uncovered |
| [Development](docs/development.md) | Building locally |

## License

Apache-2.0. See [LICENSE](LICENSE).
