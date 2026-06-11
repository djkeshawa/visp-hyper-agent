# Visp Hyper Agent — Vision & Implementation Plan

## Context

**The vision:** an agent-support framework for coding tools (Claude Code, Codex, Copilot, OpenCode) that makes implementation *accurate* and *token-efficient* — even on cheaper (Sonnet-class) models — by giving the coding tool four things it lacks:

1. **Active memory** — persistent, cross-session project knowledge that is proactively injected where it changes outcomes (provided by **llm-memory**)
2. **Structured code flow** — spec-driven, gated, evidence-backed workflow (provided by **visp-kit**)
3. **Adaptive cost control** — init-time configuration of optimal subagent fleets + model tiers per tool, and in-session model-routing adjustments driven by token telemetry — **quality-first: cost is only reduced when evidence shows accuracy holds**
4. **Self-improvement** — skills discovered during coding sessions are harvested and installed into the project automatically (Hermes-bot style), so the toolchain compounds in capability over time

**visp-hyper-agent is the orchestration layer** that fuses both: a user inside a Claude Code session runs one hyper command, and the entire pipeline fires — context compiled from kit artifacts + recalled memory, gates enforced, handoff protocol printed, results verified, and learnings written back to memory.

### Why this works (the accuracy thesis)

Cheap models fail not from lack of intelligence but from **bad context and unbounded scope**. The ecosystem attacks exactly that:

- visp-kit produces **task-scoped context packs** (allowed/forbidden files, acceptance criteria, validation commands) — the model can't wander.
- llm-memory injects **distilled past knowledge** (gotchas, conventions, fragile areas) — the model doesn't repeat mistakes.
- visp-hyper-agent sequences it deterministically and **verifies after every step** — errors are caught mechanically, not by the model's self-assessment.

### Current state (verified by exploration)

| Project | State | Integration surface |
|---|---|---|
| **visp-hyper-agent** (this repo, TS) | v0.1.0 skeleton; file-based memory; own relevance scanner; typed Phase-2 seams (`MemoryProvider`, `SemanticMemoryProvider`, `ValidationCommandRunner`, `BranchSessionLocator`, `McpBridge` in `src/core/types.ts`) | — |
| **visp-kit** (TS) | v0.1.1, 546 tests passing. CLI-only (`visp`), **every command supports `--json`**, exit code 0/1 for gates. Generates per-task context packs (`.visp/features/<f>/context/T00x.context.json`), prompts, checklists, budget tracking, run traces. Gate rules VSP001–VSP020. `visp hooks claude` emits a PreToolUse gate hook. | Shell out + parse JSON (zod); read `.visp/` artifacts directly |
| **llm-memory** (Python) | v0.5.0 alpha, 366 tests passing. Layers: episodic/semantic/intent. Backends: SQLite (default), ArcadeDB, Neo4j. Surfaces: Python lib, CLI, **FastAPI REST** (`POST /recall`, `POST /memories`), **MCP server** (`llm-memory-mcp`). Hybrid recall with token-budget trimming. | HTTP REST (recommended) or MCP |

**Hard constraints to preserve:** visp-hyper-agent makes **no LLM calls** ever; all orchestration is deterministic; llm-memory stays an *optional* runtime (file memory remains the zero-dependency default); visp-kit is consumed via CLI `--json` + artifact reads, never collapsed into this package.

---

## Architecture (target)

```
┌─────────────────────────────────────────────────────────┐
│  Coding tool session (Claude Code / Codex / Copilot)     │
│  user: "visp-hyper run 'add note pinning'"               │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  visp-hyper (orchestrator — deterministic, no LLM)       │
│                                                          │
│  Pipeline engine        Tool adapters       Telemetry    │
│  (task DAG state        (handoff, slash     (budget,     │
│   machine, gates)        cmds, MCP, hooks)   eval loop)  │
└────────┬───────────────────────┬────────────────────────┘
         ▼                       ▼
┌──────────────────┐   ┌─────────────────────────────┐
│ visp-kit bridge   │   │ memory bridge                │
│ `visp … --json`   │   │ file (default) │ llm-memory  │
│ + .visp/ artifact │   │ (HTTP REST, optional MCP)    │
│ reads             │   │                              │
└──────────────────┘   └─────────────────────────────┘
```

---

## Milestones

### M1 — Visp-Kit command bridge (the spine)

The biggest accuracy lever: stop duplicating what visp-kit already does better, and drive it programmatically.

1. **`src/kit/kit-command-bridge.ts`** — typed subprocess wrapper over `visp <cmd> --json`:
   - `detectVisp(projectPath)` → binary present? kit initialized? (probe `visp status --json`, exit code + parse)
   - Typed methods: `status()`, `policyValidate()`, `gateNext()`, `gateImplement(taskId)`, `contextPack(taskId)`, `verify(taskId)`, `review(taskId)`, `reconcile(taskId)`, `recordBudget(...)`, `nextStep()`
   - Zod schemas mirroring visp-kit's `GateResult`, `ContextPack`, task-graph shapes (new `src/kit/kit-schemas.ts`; keep minimal — parse only fields we consume)
   - Graceful degradation: if `visp` missing or kit uninitialized → return `null`, callers fall back to today's `kit-reader.ts` artifact reads + own relevance scanner. **Existing behavior is the fallback path, never removed.**
2. **Context-pack adoption** in `start`: when a kit task context pack exists (`T00x.context.json`), use it as the context source (it has allowed/forbidden files, snippets, validation commands, token estimates) instead of the relevance scanner. Scanner remains for kit-less projects.
3. Tests: bridge against a fixture `.visp/` tree + a fake `visp` shim script on PATH (no real visp-kit dependency in CI).

### M2 — llm-memory provider (the active memory)

4. **`src/memory/llm-memory-provider.ts`** — `LlmMemoryProvider implements SemanticMemoryProvider` over the FastAPI REST surface:
   - `recall(query, opts)` → `POST /recall` (layers episodic+semantic+intent, `token_budget` from config, `repo_id` derived from project path)
   - `remember(record)` → `POST /memories` (layer `episodic`, category `session`)
   - `storeDecision(d)` → `POST /memories` (category `architecture_decision`)
   - `getProjectProfile(path)` → repo-scoped memory summary
   - `semanticRecall` → same endpoint, vector-mode flag
5. **Config & lifecycle**: extend `HyperConfig.memoryMode` to `"file" | "llm-memory"` (zod enum + types + defaults in lockstep). Provider factory in `src/memory/provider-factory.ts`. Health check (`GET /` with short timeout) at session start; on failure **warn and fall back to file memory** — never block the pipeline.
6. **Memory-pack fusion**: `start` merges file memory + recalled llm-memory results into `memory-pack.md`, sorted by relevance score, trimmed to the session token budget. Tag each entry with its source and score so the coding agent can weigh it.
7. **Write-back discipline**: `remember` writes both to `.visp/memory/session-history/` (file, always) and llm-memory (when enabled). `review` findings with warnings → stored as semantic `gotcha`/`fragile_area` memories. This is the **learning loop**: every session makes the next one smarter.
8. **Proactive memory — make it *super useful*, not a dump**: memory must arrive at the moment it changes the model's behavior, scoped to what's being touched:
   - **Per-task injection**: each `next` action block recalls memories scoped to that task's allowed files + keywords (llm-memory's `files`/`task_id` ranking params), not a generic session-wide blob. A warning about `session-manager.ts` appears *in the task that edits it*.
   - **Before-change warnings**: checkpoint/next surface `fragile_area`/`gotcha`/`antipattern` memories for the files about to be edited (the `memory_before_change` pattern), rendered as explicit `⚠ known-risk` lines in the action block.
   - **Utility feedback loop**: handoff asks the agent to mark which injected memories were actually useful; `remember` reports this back to llm-memory's utility-feedback ranking, so recall quality improves with use and noise decays.
   - **Token discipline**: every recall passes a `token_budget` slice (from `HyperConfig.tokenBudget`); memory never crowds out task context.
9. Tests: mock HTTP server (vitest + `node:http`); contract tests for the schema mapping; ranking-param tests for per-task scoped recall.

### M3 — Pipeline engine & multi-step orchestration (the brain)

10. **`visp-hyper run "<goal>"`** — the one-command pipeline (new `src/pipeline/pipeline-engine.ts` + `src/cli/commands/run.ts`):
   - Kit-mode: `status → policy validate → gate next → (feature/clarify/spec/plan/tasks as gates allow) → context T00x → emit per-task handoff`. Each step is a typed state transition; gate-blocked → print the blocking rule + `nextAllowedCommand` and stop cleanly (respect VSP019/VSP020 — never bypass).
   - Kit-less mode: today's `start` flow, unchanged.
   - State persisted in session record: extend `SessionRecord` with `pipeline: { taskGraph, currentTaskId, stepHistory }` (zod in lockstep).
   - `--interactive` flag prints clarification questions (from `visp clarify --json`) for the user to answer in-session, then resumes.
11. **`next` becomes a task-DAG state machine**: walks `task-graph.json` honoring `dependsOn`, emits one *bounded action block* per task: goal, allowed/forbidden files, acceptance criteria, validation commands, done-criteria. After the coding agent reports done, `visp-hyper checkpoint --task T00x` runs verify/review via the bridge and only then advances. Parallelizable tasks are flagged so multi-agent setups can fan out.
12. **`ValidationCommandRunner` implementation** (`src/quality/validation-runner.ts`): detection (kit task validation commands → package.json scripts → heuristics) + execution with captured exit codes/output, included in checkpoint evidence. Allowlist execution to detected project commands only.
13. **`BranchSessionLocator` implementation** (`src/core/branch-session-locator.ts`): `git rev-parse --abbrev-ref HEAD` → sessions keyed per branch; switching branches resumes that branch's session.

### M4 — In-session tool integration (the UX)

How "run hyper agent commands inside a Claude Code session" actually feels:

14. **Subagent fleet + model configuration at init** — `visp-hyper init --tool claude-code` (and codex/copilot) configures the *optimal agent topology and model assignments* for that tool, not just command wrappers:
    - **Claude Code**: writes a coordinator/scout/implementer subagent fleet to `.claude/agents/` (coordinator = orchestrate/validate on the session's strongest cheap tier; scout = scanning/mechanical work on Sonnet-class; implementer = real logic on Opus-class), plus `.claude/commands/hyper-*.md` slash commands (`hyper-run`, `hyper-next`, `hyper-checkpoint`, `hyper-review`, `hyper-remember`) that shell to `visp-hyper` and instruct the agent to obey the printed handoff. A `permissions` allowlist for `visp`, `visp-hyper`, and detected validation commands is offered too.
    - **Codex**: `AGENTS.md` section + `.agents/skills/` entries with equivalent role/model guidance; **Copilot**: `.github/instructions/` files.
    - **Model map is data, not hardcode**: `templates/<tool>/model-map.json` maps roles → model tiers per tool, versioned with the package so new models are a template update. The map is the *initial* configuration; M5's adaptive routing tunes it per-project from evidence.
    - Cooperate with `visp agent bootstrap` output — append/own clearly-marked blocks, never clobber kit-generated files.
15. **Hook wiring**: during init for claude-code, surface (or install with consent) visp-kit's PreToolUse gate hook (`visp hooks claude`) so out-of-scope edits are *mechanically blocked*, not just discouraged by prompt text.
16. **MCP server mode** (`visp-hyper serve --mcp`) implementing the `McpBridge` seam — expose `hyper_start`, `hyper_next`, `hyper_checkpoint`, `hyper_review`, `hyper_remember` as MCP tools. Use the official MCP TS SDK as an **optional peer / lazy import** so the core package stays dependency-light. (Sequenced last in M4: slash commands deliver the same UX sooner at zero dependency cost.)

### M5 — Telemetry & adaptive model routing (the cost/accuracy loop)

17. **Budget round-trip**: handoff instructs the agent to report token usage at `remember`; `visp-hyper remember --input-tokens X --output-tokens Y` pipes into `visp budget --record-usage` via the bridge (or `--record-usage-unavailable` when the surface doesn't expose counts). Per-task usage is also stored alongside checkpoint evidence so routing decisions (below) have per-task-class data.
18. **Adaptive model routing — quality-first, evidence-gated**: during a session, hyper evaluates token cost and emits *routing directives* the LLM session acts on (hyper itself never calls an LLM; it computes deterministic recommendations from telemetry):
    - Each `next`/`checkpoint` output includes a `model_routing` block: `suggested_tier` per upcoming task, derived from kit task `riskLevel`, context-pack token estimate, acceptance-criteria count, and the project's *historical evidence* (first-attempt verify pass rate per tier × task class, from item 17).
    - **Downgrade rule (cost)**: a task class is routed to a cheaper tier only when evidence shows that tier's first-attempt verify/review pass rate meets a threshold (default ≥90%) on similar tasks in this project. No evidence → default map from init, never blind downgrade.
    - **Upgrade rule (quality, asymmetric)**: any verify/review failure immediately escalates that task to the stronger tier for the retry, and quarantines that task class from downgrades for N sessions. **Quality recovers instantly; cost savings must be re-earned.**
    - Routing state lives in `.visp/hyper/routing.json` (zod-validated); the coordinator subagent reads the directive and dispatches accordingly. `visp-hyper report` shows projected vs. actual savings *and* the pass-rate delta, so cost cuts that hurt accuracy are visible and reversible.
19. **`visp-hyper report`**: aggregates across sessions — tasks completed, verify/review pass rates on first attempt *per model tier*, token usage vs. budget estimates, memory-recall usefulness, routing-decision outcomes. This is the evidence that the framework lets Sonnet-class models match expensive-model accuracy.
20. **Memory distillation pass**: at `remember`, structured extraction of decisions/follow-ups/warnings from checkpoint + review evidence into semantic memories (deterministic templating — still no LLM calls in this package; the *coding agent* writes the summary text, hyper just routes and stores it).

### M6 — Self-improving skills (the Hermes loop)

The toolchain should get better at *this project* the more it's used. When a session surfaces a reusable capability, hyper captures it as a first-class skill artifact instead of letting it evaporate with the context window.

21. **Skill proposal protocol**: the handoff instructs the coding agent — when it notices a recurring procedure worth keeping (a deploy dance, a tricky codegen invocation, a project-specific debugging recipe) — to emit a structured `SKILL_PROPOSAL` block (name, description, when-to-use, body, evidence of use). `visp-hyper checkpoint`/`remember` parses it; hyper never authors skill content itself (no LLM calls — the agent writes, hyper validates and routes).
22. **Skill registry + installer** (`src/skills/`): proposals are zod-validated, deduplicated against existing skills (name + description similarity against the registry index), and installed in the tool-native format — Claude Code `.claude/skills/<name>/SKILL.md`, Codex `.agents/skills/`, Copilot `.github/instructions/`. A registry index at `.visp/hyper/skills.json` tracks origin session, usage count, and last-used.
    - **Governance**: default mode `auto` installs immediately and reports what was added (the Hermes-bot behavior); `review` mode stages proposals in `.visp/hyper/skill-proposals/` for human approval — configurable in `HyperConfig`. Skills are namespaced (`hyper-<name>`) and never overwrite kit-generated or hand-written files.
23. **Skill lifecycle**: each session's handoff lists available project skills with when-to-use hooks; `remember` records which were used. Unused-for-N-sessions skills are flagged for pruning in `visp-hyper report` — the library compounds in usefulness, not clutter. Skill metadata also gets mirrored into llm-memory (semantic `pattern` entries) so recall can suggest "there's a skill for this" on related tasks.

---

## Suggested improvements beyond the original vision

- **Failure-pattern memory**: when verify/review fails, store the failure signature as a semantic `antipattern` memory; future context packs for similar files surface it proactively (llm-memory's `memory_before_change` concept, driven from hyper).
- **`visp-hyper doctor`**: one command validating the whole triad — visp binary, kit init state, llm-memory server health, hook installation, tool assets freshness.
- **Session resume protocol**: `visp-hyper resume` re-prints the current task's handoff with delta context (what changed since last checkpoint) — cheap re-grounding after context-window resets, a chronic pain for long agent sessions.
- **Packaging for adoption**: publish `visp-hyper` to npm; document a `docker compose` (or systemd user unit) for `llm-memory serve`; quickstart that goes from zero → gated, memory-backed Claude Code session in <5 minutes.

## Sequencing & dependency notes

- M1 → M3 is the critical path (bridge before pipeline). M2 is independent of M1 and can proceed in parallel. M4 depends on M3 (commands must exist to wrap). M5 depends on M1 (budget bridge) + M2 (memory write-back) + M4 (the fleet that routing directs). M6 depends on M3 (checkpoint/remember parse proposals) + M4 (tool-native skill formats); its memory mirroring needs M2.
- llm-memory is Python: keep it strictly optional behind `memoryMode`, document install (`pipx install llm-memory`), pin minimum version 0.5.x, and version the REST contract in the provider (fail soft on schema drift).
- Every config/state shape change updates **types + zod schemas + defaults together** (existing repo convention); tool-profile additions touch all four registration points.

## Verification

- Per-milestone: `pnpm check` (typecheck + vitest + build) green; new modules get dedicated test files mirroring `tests/*.test.ts` conventions.
- Integration fixtures: a synthetic target project with a pre-baked `.visp/` tree (kit artifacts, task graph, context packs) + fake `visp` shim; a mock llm-memory HTTP server. End-to-end test: `run` → handoff printed → simulated checkpoint → verify advance → `remember` → memory written.
- Live smoke test: run the real triad against a sample repo with actual visp-kit + llm-memory installed; confirm gate blocking, context-pack adoption, and memory recall round-trip from inside a Claude Code session.
- Routing-quality regression check: simulated telemetry fixtures proving the downgrade rule never fires without pass-rate evidence and that a verify failure always escalates the retry tier (the quality-first invariant, encoded as tests).
- Skill-loop test: fixture session emits a `SKILL_PROPOSAL` → validated, installed to `.claude/skills/`, registered in `skills.json`, deduplicated on second emission, surfaced in the next session's handoff.
