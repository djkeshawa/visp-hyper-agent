# visp-hyper-agent

Local-first workflow controller for Codex, Claude Code, GitHub Copilot, OpenCode, and similar AI coding tools.

Visp Hyper Agent does not replace coding agents and never calls an LLM itself. It prepares task-scoped handoffs, enforces Visp Kit gates, records checkpoint evidence, and stores session memory for the coding tool you already use:

- **Structured code flow** — drives the gated [Visp Kit](https://github.com/djkeshawa/visp-kit) workflow through its CLI, adopts task-scoped context packs, and presents Kit's exact ready action. Hyper checkpoints remain local evidence and never grant strict permission.
- **Active memory** — recalls and persists project knowledge through [llm-memory](https://github.com/djkeshawa/llm-memory) (optional; file-based memory is the zero-dependency default).
- **Claude Code subagent fleet (install-time)** — for the `claude-code` tool, `init` installs a coordinator/scout/implementer subagent set with per-role model tiers from a static `model-map.json`, and the installed `/hyper-run` command drives the coordinator to delegate the scout pass to the `scout` subagent and implementation to the `implementer` subagent through Claude Code's native Agent tool. Other tools have no dispatch mechanism and instead get an honest sequential scout-then-implement role framing. Across all tools, hyper emits evidence-gated model-routing advice that only downgrades tiers when local pass-rate data proves quality holds.
- **Self-improvement** — harvests reusable skills your agent discovers during sessions and installs them as project skills.

Everything is file-based under the target project's `.visp/` directory. No network calls (except to your own optional llm-memory server), no database, no embeddings, no new runtime dependencies.

**New here? Follow the [five-minute quickstart](examples/quickstart.md) to see a commit get blocked and a task verified.**

## Install

Prerequisites:

- Node.js 24+
- A project using Git
- Visp Kit for strict gated workflows

Install the CLI from npm:

```bash
npm install -g visp-hyper-agent
visp-hyper --help
```

Or run it without a global install:

```bash
npx --package visp-hyper-agent visp-hyper --help
```

Use it inside a project:

```bash
visp-hyper init --tool codex
visp-hyper run "implement offline note sync"
visp-hyper checkpoint --task T001
visp-hyper remember --summary "Implemented offline note sync"
```

## Commands

| Command | What it does |
|---|---|
| `visp-hyper init [--tool <tool>] [--force-assets] [--with-hooks]` | Creates `.visp/hyper/` config and state. With `--tool` it also installs native assets for that coding tool (subagent fleet, slash commands, instructions) and, for `claude-code` projects with a real Visp Kit, surfaces or installs the `visp hooks claude` PreToolUse gate. |
| `visp-hyper quick "<goal>" [--files <paths...>] [--tool <tool>]` | Starts a zero-configuration local task only when the project is genuinely Kit-less. A healthy or configured-but-unhealthy Kit stops the command before it creates Hyper state. |
| `visp-hyper run "<goal>" [--tool <tool>]` | The one-command pipeline. In a Visp Kit project: checks the Kit integration contract, validates policy, evaluates gates, and prints either a per-task handoff + bounded action block, or a `BEGIN_VISP_PIPELINE_BLOCKED` block naming the exact next allowed `visp` command. Kit-less projects get the plain `start` behavior. |
| `visp-hyper start "<goal>" [--tool <tool>]` | Starts a guided local session only when the project is genuinely Kit-less. A healthy or configured-but-unhealthy Kit stops the command before it creates Hyper state; use `run` for Kit-backed work. The local path writes the handoff and context files, uses the deterministic relevance scanner, and fuses recalled llm-memory entries when enabled. |
| `visp-hyper next` | Prints the next bounded action: the current pipeline task's action block (with model-routing advice) when a task DAG is active, otherwise the generic next-step block. |
| `visp-hyper resume [--json]` | Reprints the active handoff, current task action, context freshness, required read status, latest checkpoint, current git diff file list, and exact checkpoint-to-current file deltas after a context reset. |
| `visp-hyper checkpoint [--task <id>] [--tier <tier>]` | Appends git diff evidence to `checkpoints.md`. With `--task`: runs Visp Kit verify + review through the bridge, confirms pinned Kit context and provenance artifacts have not changed since handoff, and records the attempt in telemetry. Its result is local evidence; strict progression and remediation come only from Kit's exact current ready action. |
| `visp-hyper review` | Writes `review-report.md` and prints `BEGIN_VISP_REVIEW_RESULT` (deterministic path-based warnings from `git diff`). |
| `visp-hyper remember [--summary <s>] [--decision <d>...] [--follow-up <f>...] [--used-skill <name>...] [--input-tokens <n>] [--output-tokens <n>] [--model <m>]` | Records session learnings: always writes `.visp/memory/session-history/`; additionally writes to llm-memory (session record, decisions, follow-ups) when enabled, records token usage in telemetry and forwards it to `visp budget`, harvests pending skill proposals, and tracks skill usage. It does not complete a Kit task. |
| `visp-hyper report [--json]` | The cost/accuracy evidence view: first-attempt verify+review pass rates per model tier and per task class, token totals, active routing quarantines, recent routing decisions, and skill usage with prune flags. |
| `visp-hyper status` | Session metadata, generated files, context freshness, checkpoint/review state, and memory status. |
| `visp-hyper doctor [--json]` | Read-only compatibility check for the Hyper + Visp Kit chain: Hyper state, active context freshness, Kit artifacts, `visp --json` parsing, Kit contract capabilities including provenance freshness and orchestrator read contracts, policy validation, next gate, active task context pack, git scope hook, and MCP surface manifest hash. |

## MCP Server

`visp-hyper serve --mcp` exposes the same orchestration surface over stdio JSON-RPC for MCP-capable tools.

Each tool advertises JSON Schema for both inputs and outputs. Calls still return
the human-readable Visp blocks, and also include `structuredContent` with status,
frame, resource URI, and raw text fields so MCP hosts and weaker coding models do
not need to scrape prose to understand whether a gate passed.

Tools:

- `hyper_quick`
- `hyper_run`
- `hyper_next`
- `hyper_resume`
- `hyper_status`
- `hyper_doctor`
- `hyper_checkpoint`
- `hyper_guard`
- `hyper_review`
- `hyper_remember`
- `hyper_report`

Resources:

- `visp-hyper://meta/surface-manifest`
- `visp-hyper://current/context-freshness`
- `visp-hyper://current/kit-read-contract`
- `visp-hyper://current/session`
- `visp-hyper://current/context-pack`
- `visp-hyper://current/context-manifest`
- `visp-hyper://current/memory-pack`
- `visp-hyper://current/quality-gates`
- `visp-hyper://current/agent-instructions`
- `visp-hyper://current/handoff-json`
- `visp-hyper://current/checkpoints`
- `visp-hyper://current/checkpoint-snapshot`
- `visp-hyper://current/review-report`
- `visp-hyper://prompts/handoff`

`visp-hyper://meta/surface-manifest` is always available. It declares the fixed MCP tool/resource/prompt surface, per-tool input schema hashes, the server version, and a stable SHA-256 `surfaceHash` so MCP hosts and enterprise reviewers can detect unexpected surface drift.
It also hashes each tool output schema, making text-only regressions and schema drift visible to integration checks.
`visp-hyper://current/context-freshness` is also always available. It reports the active context pack and grounded Kit artifact freshness as JSON, including `status`, `blocking`, hashes, warnings, and any finding that should stop a coding agent before it drifts.
`visp-hyper://current/kit-read-contract` is always available too. When a Kit `1.3` handoff is active, it returns the adopted artifact roles, MIME types, required stages, and freshness policy; otherwise it returns an explicit `unavailable` status.

Prompts:

- `hyper_resume`
- `hyper_run_goal`

## Develop Locally

Prerequisites:

- Node.js 24+
- pnpm 11+

```bash
pnpm install
pnpm build
node dist/index.js --help
```

Use a local build inside a project:

```bash
node /path/to/visp-hyper-agent/dist/index.js --project /path/to/project init --tool claude-code
node /path/to/visp-hyper-agent/dist/index.js --project /path/to/project run "implement offline note sync"
```

## Example Claude Code Workflow

Set up once:

```bash
visp-hyper init --tool claude-code
```

This installs into the project:

```text
.claude/agents/coordinator.md     # routes work, validates results (model: inherit)
.claude/agents/scout.md           # scanning + mechanical work (model: sonnet)
.claude/agents/implementer.md     # real logic (model: opus)
.claude/commands/hyper-run.md     # /hyper-run, /hyper-next, /hyper-checkpoint,
.claude/commands/hyper-*.md       # /hyper-review, /hyper-remember
```

The per-role model tiers above are static assignments written at install time from
`templates/claude-code/model-map.json` — this dispatch fleet is a Claude Code
feature only. Other tools follow the sequential scout-then-implement role framing in
their installed instructions instead.

Then, inside a Claude Code session:

```text
/hyper-run implement offline note sync
# → handoff + task action block (allowed/forbidden files, acceptance
#   criteria, validation commands) + model_routing advice.
#   Acting as the coordinator, delegate the scout pass to the `scout`
#   subagent and implementation to `implementer` via the Agent tool,
#   validating each result before checkpointing.

/hyper-checkpoint T001
# → collects verify + review evidence; follow Kit's exact ready action for strict progress

/hyper-remember done: implemented note sync --input-tokens 18000 --output-tokens 4200
# → session memory, token telemetry, budget round-trip, skill harvest
```

The same flow works tool-agnostically: `--tool codex` writes `AGENTS.visp-hyper.md` + `.agents/skills/`, `--tool copilot` writes `.github/instructions/`.

## Output Blocks

All orchestration output is deterministic, delimited text designed for LLM consumption:

- `BEGIN_VISP_AGENT_HANDOFF` — session contract: required file reads, MCP resources including computed context freshness, workflow, hard rules, installed project skills, and the skill-proposal protocol.
- `BEGIN_VISP_TASK_ACTION` — one bounded task: goal, allowed/forbidden files, acceptance criteria, validation commands, done criteria. When the current task is `parallelizable` and other ready sibling tasks (all dependencies completed, also parallelizable) exist, it also carries a `may_run_concurrently_with: <ids>` line naming that ready-set; the line is omitted otherwise.
- `BEGIN_VISP_PIPELINE_BLOCKED` — a gate refused: failed rules and the exact next allowed `visp` command. Unparseable gate results fail closed.
- `BEGIN_VISP_CHECKPOINT_RESULT` — verify/review outcomes and the next task (or `pipeline_complete`).
- `BEGIN_VISP_MODEL_ROUTING` — advisory tier suggestion with its evidence (samples, pass rate).
- `BEGIN_VISP_ADAPTATION` — deterministic reaction to repeated checkpoint failures: after 2 consecutive failures a scoped remediation task (`R-<task>-<n>`, findings verbatim, same file scope) is injected and made current; a failing remediation or a 3-failure streak issues an escalation directive instead. All rule-driven — no LLM.
- `BEGIN_VISP_WORKFLOW_DIRECTIVE` — advisory fan-out plan, printed only when the remaining DAG has ≥ 2 independent `parallelizable` tasks with disjoint `allowedFiles` scopes. claude-code is told to dispatch parallel tasks to native subagents (see the `hyper-fanout` command); every other tool gets an explicitly sequential interpretation. Checkpoints always stay sequential.
- `VISP_HYPER_REPORT` — the aggregate cost/accuracy report.

Existing installs predating these blocks should re-run `visp-hyper init --tool <tool> --force-assets` to refresh the per-tool agent assets (installs never overwrite without `--force-assets`).

## Adaptive Model Routing (quality-first)

Routing advice is computed deterministically from local telemetry — visp-hyper never selects or calls a model:

- **Baseline**: low-risk tasks suggest the cheap tier (`scout`); everything else suggests the strong tier (`implementer`).
- **Downgrades must be earned**: a task class is suggested for the cheap tier only after ≥ 3 first-attempt records at ≥ 90% verify+review pass rate on that tier.
- **Quality recovers instantly**: any checkpoint failure escalates the suggestion to the strong tier and quarantines the task class from downgrades for 3 sessions.

`visp-hyper report` shows the pass-rate evidence behind every decision, so cost cuts that hurt accuracy are visible and reversible.

## Active Memory (optional)

```bash
pipx install llm-memory
llm-memory serve              # default http://localhost:8000
```

Enable in `.visp/hyper/config.json`:

```json
{ "memoryMode": "llm-memory", "memoryEndpoint": "http://localhost:8000" }
```

- `start`/`run` recall memories relevant to the goal and render them in `memory-pack.md` with an exact per-record source URI and relevance-score tags, capped so memory never crowds out task context.
- Failed checkpoints are deduped into `.visp/hyper/failure-patterns.json`; future `start`/`run` handoffs surface related gotchas in `memory-pack.md`.
- Kit-backed handoffs pin the adopted context artifact hash and Kit provenance hashes in `context-manifest.json`; `checkpoint --task` fails closed if the context pack or any grounded spec/task/plan/policy artifact changes before validation.
- When Kit context packs include artifact provenance, Hyper copies those SHA-256 hashes into `context-manifest.json` so MCP clients can audit which spec/task/plan/policy artifacts grounded the handoff.
- When Kit advertises contract `1.3`, Hyper also copies the typed orchestrator read contract into `context-manifest.json` under `kitReadContract`, preserving artifact roles, MIME types, required stages, and freshness policy for MCP hosts and weaker agents.
- If an adopted Kit context pack has no artifact provenance, Hyper records a `freshnessWarnings` entry in `context-manifest.json` and mirrors it in `context-pack.md`.
- `remember` writes the session record, decisions (episodic), and follow-ups (intent) back; installed skills mirror as semantic patterns. This records learnings and does not complete a Kit task.
- Auth: set `VISP_HYPER_MEMORY_API_KEY` (sent as `X-API-KEY`); keys never live in config files.
- The server being down is never an error: commands warn and fall back to file memory.

## Skill Harvesting

When your coding agent notices a reusable procedure, it writes a proposal file (the handoff documents the format):

```text
.visp/hyper/skill-proposals/incoming/restart-stack.md
---
name: restart-stack
description: Restart the dev stack cleanly after schema changes.
when_to_use: After any database migration.
evidence: Needed twice this session.
---
1. Stop the dev server. 2. pnpm db:reset && pnpm db:migrate. 3. ...
```

`remember`/`checkpoint` validate, dedupe, and (in the default `skillMode: "auto"`) install it as a namespaced project skill — e.g. `.claude/skills/hyper-restart-stack/SKILL.md` — registered in `.visp/hyper/skills.json`. Set `skillMode: "review"` to stage proposals for human approval instead. Future handoffs advertise installed skills; `report` flags skills unused for 5+ sessions as prune candidates. Existing files are never overwritten.

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

## Tool Profiles

Supported profiles: `generic`, `codex`, `claude-code`, `copilot`, `opencode`.

`--tool` changes handoff metadata, profile wording, and asset install destinations while preserving the shared protocol structure. Unknown values are rejected by the CLI. Only `claude-code` ships a subagent fleet with a `templates/claude-code/model-map.json`; for that tool, new model assignments are a data update, not a code change. The other tools have no dispatch mechanism and use the sequential scout-then-implement role framing instead.

## Current Limits

- Local-first and file-based; the only network surface is your own llm-memory endpoint, and only when enabled.
- No external LLM API calls — all orchestration, routing, and harvesting is deterministic; agents author content, hyper validates and routes it.
- Review checks are deterministic path-based warnings, not full static analysis.
- Visp-Kit artifacts are consumed via its CLI and files; this tool does not generate kit specs or plans.
- Routing directives are advisory text; the coding tool owns actual model selection.

## Development

Keep source and test changes separate from documentation-only cleanup, and run
`pnpm check` before committing either scope. The local `.visp/` directory is
ignored workflow evidence: if it is deleted before a task closes, recreate the
task and collect fresh evidence rather than claiming the earlier task complete.

```bash
pnpm check     # typecheck + test + build
pnpm test
pnpm exec vitest run tests/<file>.test.ts
```
