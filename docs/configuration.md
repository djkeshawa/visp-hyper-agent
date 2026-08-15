# Configuration and layout

## File Layout

Runtime files:

```text
.visp/
  hyper/
    config.json          # defaultTool, tokenBudget, memoryMode, memoryEndpoint,
                         # skillMode, blockedPaths, intelStore, intelRepository
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
- `src/memory/` — file memory, the llm-memory HTTP provider, and the health-checked provider factory.
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

## Legacy private Memory compatibility

```bash
# Existing migration environments only:
llm-memory serve
```

Enable in `.visp/hyper/config.json`:

```json
{ "memoryMode": "llm-memory", "memoryEndpoint": "http://localhost:8000" }
```

- This mode is retained only for existing private migrations. It is not the
  Phase 4 public Memory adapter.
- The public adapter will target `visp-memory` only after its independent export
  gates produce a stable versioned query/lifecycle contract.
- File memory remains the supported zero-dependency public fallback.
- Existing `start`/`run` calls render legacy recalled records with source URIs
  and bounded relevance data; those records remain untrusted context.
- Failed checkpoints are deduped into `.visp/hyper/failure-patterns.json`; future `start`/`run` handoffs surface related gotchas in `memory-pack.md`.
- Kit-backed handoffs pin the adopted context artifact hash and Kit provenance hashes in `context-manifest.json`; `checkpoint --task` fails closed if the context pack or any grounded spec/task/plan/policy artifact changes before validation.
- When Kit context packs include artifact provenance, Hyper copies those SHA-256 hashes into `context-manifest.json` so MCP clients can audit which spec/task/plan/policy artifacts grounded the handoff.
- When Kit advertises contract `1.3`, Hyper also copies the typed orchestrator read contract into `context-manifest.json` under `kitReadContract`, preserving artifact roles, MIME types, required stages, and freshness policy for MCP hosts and weaker agents.
- If an adopted Kit context pack has no artifact provenance, Hyper records a `freshnessWarnings` entry in `context-manifest.json` and mirrors it in `context-pack.md`.
- `remember` writes the session record, decisions (episodic), and follow-ups (intent) back; installed skills mirror as semantic patterns. This records learnings and does not complete a Kit task.
- Auth: set `VISP_HYPER_MEMORY_API_KEY` (sent as `X-API-KEY`); keys never live in config files.
- The server being down is never an error: commands warn and fall back to file memory.
## Current Limits

- Local-first and file-based; the only network surface is your own llm-memory endpoint, and only when enabled.
- No external LLM API calls — all orchestration, routing, and harvesting is deterministic; agents author content, hyper validates and routes it.
- Review checks are deterministic path-based warnings, not full static analysis.
- Visp-Kit artifacts are consumed via its CLI and files; this tool does not generate kit specs or plans.
- Routing directives are advisory text; the coding tool owns actual model selection.
