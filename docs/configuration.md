# Configuration and layout

## File Layout

Runtime files:

```text
.visp/
  hyper/
    config.json          # defaultTool, tokenBudget, memoryMode, memoryEndpoint,
                         # memoryRepoId, skillMode, blockedPaths, intelStore,
                         # intelRepository
    state.json           # sessions + pipeline state (task DAG progress),
                         # plus `activity`: the last 20 work-driving verbs
    telemetry.json       # checkpoint attempts + token usage
    routing.json         # quarantines + routing decisions
    failure-patterns.json # failed checkpoint gotchas for future sessions
    skills.json          # installed-skill registry
    skill-proposals/     # incoming/ staged/ rejected/
    current/
      session.md  context-pack.md  context-manifest.json  memory-pack.md
      quality-gates.md  agent-instructions.md  handoff.json
      checkpoints.md  checkpoint-snapshot.json  review-report.md
  memory/
    project-summary.md  architecture-decisions.md  known-risks.md
    session-history/
```

Source modules:

- `src/cli/commands/` — command behavior (`run` and `start` are the orchestrators).
- `src/kit/` — Visp Kit integration: artifact reader plus the typed `visp --json` command bridge that distinguishes genuine Kit absence from configured-but-unhealthy authority failures.
- `src/pipeline/` — pure task-DAG state machine (topological ordering, evidence-gated advancement, action blocks).
- `src/context/` — deterministic relevance scanner (the kit-less context fallback).
- `src/memory/` — file memory, the versioned `visp-memory` CLI contract client, the llm-memory HTTP provider, the health-checked provider factory that chooses between them, and the mode default that reports whether a real store is reachable here.
- `src/routing/`, `src/telemetry/` — quality-first routing engine and its evidence stores.
- `src/skills/` — skill proposal parsing, registry, and installer.
- `src/install/` — tool asset installer over the versioned `templates/` directory.
- `src/quality/` — git-diff review warnings, checkpoint snapshots, and the allowlisted validation-command runner.
- `src/handoff/`, `src/output/` — protocol and markdown rendering.
## What `state.json` says when nothing happened

Only `visp work` (and the legacy `visp start`) create a session. `new`, `plan`,
`check` and `handoff` drive Kit and create none — correctly, because a session
is bound to an adopted task with a context pack, and those verbs are what get
you to one.

That left a real gap. A head-to-head evaluation ran `visp setup`, `visp new`,
and then a full implementation task, and afterwards this file read, in full:

```json
{ "activeSessionId": null, "sessions": {} }
```

Byte-identical to a project where Hyper had never been installed. `visp doctor`
called it `[PASS] Found .visp/hyper/config.json and .visp/hyper/state.json` and
`visp status` did not mention Hyper at all, so the artifact that exists to
answer "did the coordinator do anything here" answered by existing.

Every work-driving verb now appends to `activity` — the last 20, oldest first:

```json
{
  "activeSessionId": null,
  "sessions": {},
  "activity": [
    {
      "at": "2026-08-15T13:49:19.628Z",
      "verb": "new",
      "outcome": "human-needed",
      "detail": "visp-kit clarify needs more detail before it can pass:"
    }
  ]
}
```

`outcome` is one of `goal-reached`, `human-needed`, `blocked`, `stalled`,
`kit-unavailable`, `refused`. `detail` is one clipped line of the stop's own
sentence — evidence, never a command to re-run.

Activity is not a session and never becomes one. What it buys is that the three
states which used to look identical now read differently, and both `doctor` and
`status` say which one you are in:

| On disk | What it means |
| --- | --- |
| no `.visp/hyper/` | Hyper was never set up here. `doctor` fails the `hyper-state` check. |
| sessions empty, no activity | Set up, never asked to do anything. `doctor` passes and says so. |
| sessions empty, activity present | Verbs ran and produced no session. `doctor` **warns** and `status` prints the sentence next to Kit's action. |
| sessions present | Normal. `doctor` reports the counts. |

Recording is best-effort and runs after the verb has printed its answer: a
store that cannot be written warns and never changes the verb's exit code.

## Repository intelligence (the scout lane)

The `scout` subagent `visp init --tool claude-code` installs is navigation-only: it answers from the Visp Intel graph through five `mcp__visp-intel__*` tools and has no file, shell or edit tool at all. Those tools need a provider, and the host only has one if this project's `.mcp.json` registers the `visp-intel` MCP server.

```bash
visp-intel repo index . --store .visp-intel/intel.sqlite --json   # produces the store and its repository id
visp init --intel-store .visp-intel/intel.sqlite --intel-repository <repository-id>
```

`init` records both in `config.json` as `intelStore` and `intelRepository`, then merges a `visp-intel` entry into `.mcp.json` alongside any servers already there. Both values are required together: `visp-intel mcp` has no default for either, so a half-configured scope is refused rather than registered.

Without the server the scout still runs, but it can obtain no query receipt, Hyper's collector drops every unreceipted row, and the coordinator reads an empty result that looks exactly like intel having found nothing. That is why absence is stated rather than implied: `visp doctor` reports it as the `intel-mcp` check, `visp setup` warns when it installs an agent nothing can serve, and every read of `visp-hyper://current/scout-findings` carries a `provider` block.

## Memory: `memoryMode` and `memoryEndpoint`

`memoryMode` accepts exactly two values, `file` and `llm-memory`, and the config
schema rejects anything else (`src/core/session-manager.ts`, `hyperConfigSchema`).

**`file` is the built-in default when no store is present. `llm-memory` drives
the `visp-memory` CLI contract, and is selected automatically when a store
exists.** That is the whole setting in one sentence; everything below is detail.

**`llm-memory` is the current, ordinary mode — not a legacy path.** An earlier
version of this document described it as a compatibility route for private HTTP
migrations. That was wrong in a way worth naming, because a user whose project
had just been defaulted into `llm-memory` would read it as a misconfiguration
and switch back to `file` — switching Memory off in exactly the projects that
had already installed and initialised it.

### One identifier, two mechanisms

**`"llm-memory"` names two different things, and this is the single most
confusing thing about the setting.** The name comes from an HTTP memory server,
but the mechanism it selects today is the **`visp-memory` CLI**. The same value
also still enables the HTTP path where one is configured and answering. Which
one serves a given command depends on the command:

| Surface | What it actually talks to |
| --- | --- |
| `visp recall`, `visp learn` | the `visp-memory` CLI contract only (`visp-memory contract recall` / `propose`). `memoryEndpoint`, when set, is forwarded to the CLI as `--endpoint` — it is not a transport Hyper opens itself. |
| `checkpoint --task` memory ledger | the CLI (`visp-memory record`), gated on `memoryMode === "llm-memory"`. |
| `visp doctor` Memory check | the CLI: is `visp-memory` on `PATH`, and is `memoryEndpoint` well-formed if present. It runs no HTTP probe. |
| `start` / `run` memory fusion | the HTTP provider **first** — a `GET <memoryEndpoint>/healthz` probe — and the CLI contract when that probe fails. |
| `remember` write-back | the HTTP provider only. If the probe fails it warns and writes nothing remotely; there is no CLI fallback on this path. The local `.visp/memory/session-history/` write has already succeeded either way. |

So the HTTP endpoint is not the definition of the mode. It is a second half that
only two surfaces reach, and every other surface works without any server
running at all.

**Is the HTTP half still supported?** In the code, it is live and maintained:
the provider, the health-checked factory and the fusion path are all exercised
by integration tests against a mock server, and nothing in the source marks any
of it deprecated. What the project *promises* about it is a separate question,
and the answer on file is in `README.md` under *Honest limits* — "the legacy HTTP
memory mode exists only for private migrations already using it." Read that as
the support statement and this section as the mechanism. Changing the support
statement is not this document's to do.

**A consequence worth knowing before it confuses you:** on a correctly
configured, fully working CLI-backed project with no HTTP server anywhere,
`start` and `run` still write this line into `memory-pack.md`, because the
health probe runs before the CLI fallback:

```text
- llm-memory unavailable at http://localhost:8000: fetch failed; falling back to file memory
```

Recall on that path then proceeds through the CLI contract regardless. The
warning names a real probe failure; its "falling back to file memory" wording
describes the older HTTP-only behaviour rather than what the code now does.

### How `llm-memory` gets selected

`defaultMemoryMode` (`src/memory/memory-mode-default.ts`) returns `"llm-memory"`
when **both** of these are true, and `"file"` otherwise:

1. the `visp-memory` executable is found on `PATH`, and
2. the project directory contains `visp-memory.yaml` — the manifest
   `visp-memory init` writes.

**No endpoint is consulted, and nothing is installed or created by that check.**
It reports two facts and the caller decides.

That default is consulted only where a `config.json` is being *written*: the
first `visp init` in a project, and `visp init --force`, which regenerates the
file wholesale. An ordinary config read never re-derives it, so a recorded mode
is your decision and survives everything short of an explicit regeneration.

Three other ways the mode gets set:

```bash
visp init --memory-mode llm-memory     # set it explicitly
visp init --memory-mode file           # opt out; everything else still works
visp init --memory-endpoint <url>      # sets the endpoint AND implies llm-memory
visp setup                             # flips a recorded `file` to `llm-memory`
                                       # when both conditions above already hold
```

`visp setup` will also run `visp-memory init` for a project that has no store
yet, when the CLI is present.

### Installing it

```bash
pip install 'visp-memory[mcp,capture]'   # quoted: zsh globs the bare [...]
visp-memory init                         # in the project — writes visp-memory.yaml
visp init --memory-mode llm-memory       # if the project config already said file
```

Both extras matter. Without `capture` there is no git-history seeding, and
`visp-memory init` still succeeds while capturing nothing.

No pip, or you do not want Memory? `visp init --memory-mode file`. Memory is
optional by design and every other capability works without it.

### `memoryEndpoint` is always present, and is not evidence

`memoryEndpoint` carries a schema default of `http://localhost:8000`, so a fresh
`config.json` shows that value whether or not any server exists. Reading it in
your config tells you nothing about whether an HTTP memory server is running.
`visp doctor` deliberately does not probe it.

For a shared HTTP server:

```json
{ "memoryMode": "llm-memory", "memoryEndpoint": "https://memory.example:8000" }
```

- Auth: set `VISP_HYPER_MEMORY_API_KEY` (sent as `X-API-KEY`); keys never live in
  config files.
- Configuring an endpoint does **not** replace the CLI. `recall` and `learn`
  check for the `visp-memory` binary first and refuse when it is absent,
  whatever the endpoint says.
- An unreachable or malformed endpoint is never a hard error: the affected
  surfaces warn and degrade.

### What Memory is, and is not

- Recalled records are **untrusted context**, labelled as such in
  `memory-pack.md`, and instruction-shaped content is quarantined with the
  content omitted — on both the HTTP and the CLI path. Only the HTTP path
  carries a per-record source URI and a relevance score; a record recalled
  through the CLI contract is attributed to `visp-memory (CLI contract)` and has
  no score.
- Memory is **non-authoritative**: it supplies cited knowledge and never grants
  permission, changes scope, certifies evidence, or declares readiness.
- `learn` and `remember` produce proposals and records, not durable accepted
  memory — a write becomes durable only when Memory's own reviewed lifecycle
  accepts it. `remember` records learnings and does not complete a Kit task.
- File memory remains the supported zero-dependency fallback.

### Unchanged around it

- Failed checkpoints are deduped into `.visp/hyper/failure-patterns.json`; future `start`/`run` handoffs surface related gotchas in `memory-pack.md`.
- Kit-backed handoffs pin the adopted context artifact hash and Kit provenance hashes in `context-manifest.json`; `checkpoint --task` fails closed if the context pack or any grounded spec/task/plan/policy artifact changes before validation.
- When Kit context packs include artifact provenance, Hyper copies those SHA-256 hashes into `context-manifest.json` so MCP clients can audit which spec/task/plan/policy artifacts grounded the handoff.
- When Kit advertises contract `1.3`, Hyper also copies the typed orchestrator read contract into `context-manifest.json` under `kitReadContract`, preserving artifact roles, MIME types, required stages, and freshness policy for MCP hosts and weaker agents.
- If an adopted Kit context pack has no artifact provenance, Hyper records a `freshnessWarnings` entry in `context-manifest.json` and mirrors it in `context-pack.md`.
- Installed skills mirror as semantic patterns on the `remember` HTTP write-back path.

## Current Limits

- Local-first. The only network surface Hyper itself opens is your own `memoryEndpoint`, reached by `start`/`run` and `remember` when `memoryMode` is `llm-memory`. The `visp-memory` CLI is spawned as a local subprocess; what it does with an endpoint of its own is Memory's business, not Hyper's.
- No external LLM API calls — all orchestration, routing, and harvesting is deterministic; agents author content, hyper validates and routes it.
- Review checks are deterministic path-based warnings, not full static analysis.
- Visp-Kit artifacts are consumed via its CLI and files; this tool does not generate kit specs or plans.
- Routing directives are advisory text; the coding tool owns actual model selection.
