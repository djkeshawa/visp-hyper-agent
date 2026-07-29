# Configuration and layout

## File Layout

Runtime files:

```text
.visp/
  hyper/
    config.json          # defaultTool, tokenBudget, memoryMode, memoryEndpoint,
                         # skillMode, blockedPaths
    state.json           # sessions + pipeline state (task DAG progress)
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
