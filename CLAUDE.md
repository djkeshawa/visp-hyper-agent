# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`visp-hyper-agent` is a **local-first companion workflow controller** for AI coding tools (Codex, Claude Code, Copilot, OpenCode). It does **not** call any LLM or replace a coding agent. It orchestrates disciplined sessions: drives the external **visp-kit** gated workflow through its CLI, recalls/persists project memory through an optional **llm-memory** server, prints deterministic handoff/action/routing text blocks for the active coding tool, installs per-tool agent assets, and harvests agent-proposed skills. Everything is file-based under the target project's `.visp/` directory; the only network surface is the user's own llm-memory endpoint, and only when enabled.

The published binary is `visp-hyper` (`dist/index.js`). Node ≥24 and pnpm ≥11 are required (ESM, `NodeNext` modules — local imports use `.js` extensions even from `.ts` sources). Runtime dependencies are commander + zod only; keep it that way.

## Commands

```bash
pnpm build          # tsup → dist/index.js (ESM, node24, adds shebang + dts)
pnpm test           # vitest run (all tests in tests/**/*.test.ts)
pnpm typecheck      # tsc --noEmit
pnpm check          # typecheck + test + build (run before declaring work done)

pnpm exec vitest run tests/kit-command-bridge.test.ts  # single test file
pnpm exec vitest run -t "name of the test"             # single test by name

node dist/index.js --help                              # run the CLI after build
node dist/index.js --project /path/to/target run "goal" --tool claude-code
```

## Architecture

The CLI is a thin Commander shell (`src/cli/index.ts`) over pure, single-responsibility modules. **`run` (`src/cli/commands/run.ts`) and `executeStart` (`start.ts`) are the orchestrators** — read them first. Subsystems:

1. **Session state** (`src/core/session-manager.ts`) — `.visp/hyper/config.json` + `state.json`, zod schemas in lockstep with `src/core/types.ts`. Config fields: `defaultTool`, `tokenBudget`, `memoryMode: "file"|"llm-memory"`, `memoryEndpoint`, `skillMode: "auto"|"review"`, `blockedPaths`. `SessionRecord` carries optional `pipeline` state (task DAG progress). `initializeProject` runs defensively before most reads.
2. **Kit command bridge** (`src/kit/kit-command-bridge.ts` + `kit-schemas.ts`) — typed `execFile` wrapper over `visp <cmd> --json`: `detectVisp` probe, gates, verify/review/reconcile, context packs, budget recording. Schemas are **partial mirrors** (consumed fields only, tolerant of extras). Degradation contract: warnings + null, never throws; blocked gates (exit 1 + valid JSON) are results, not errors; **unparseable gate results fail closed**. `kit-reader.ts` is the no-binary fallback for raw `.visp/` artifacts.
3. **Pipeline engine** (`src/pipeline/pipeline-engine.ts`) — pure task-DAG state machine: topological ordering with cycle detection, `BEGIN_VISP_TASK_ACTION` blocks, evidence-gated `advance`. `checkpoint --task` runs bridge verify+review and advances only on both passing.
4. **Context** — kit context packs win when a kit task is active (in `start.ts`); `src/context/relevance-scanner.ts` (deterministic keyword/artifact scoring, no embeddings) is the fallback. Blocked paths (`src/governance/blocked-files.ts`) gate every path everywhere.
5. **Memory** (`src/memory/`) — `file-memory-provider.ts` (always-on), `llm-memory-provider.ts` (fetch client over the llm-memory REST API; extra methods `recallDetailed`/`storeFollowUp`/`storePattern` beyond the frozen `MemoryProvider` seam), `provider-factory.ts` (healthz-probed selection, falls back to file with a warning). API key only from `VISP_HYPER_MEMORY_API_KEY`.
6. **Telemetry + routing** (`src/telemetry/`, `src/routing/`) — `.visp/hyper/telemetry.json` (checkpoint attempts, token usage) and `routing.json` (quarantines, decisions). `routing-engine.ts` is pure with named constants; **the quality-first invariant** (downgrades need ≥3 samples at ≥90% first-attempt pass; failures escalate instantly + 3-session quarantine) has dedicated tests — never weaken it. Directives are advisory text blocks; hyper never selects models.
7. **Skills** (`src/skills/`) — proposal parsing (constrained `key: value` frontmatter, no YAML dep), `skills.json` registry, dedupe, namespaced `hyper-<name>` per-tool installs, never-overwrite. Harvested by `remember`/`checkpoint` from `.visp/hyper/skill-proposals/incoming/`.
8. **Installer** (`src/install/tool-asset-installer.ts` + `templates/`) — plan-first writes of per-tool agent fleets/commands; model assignments live in `templates/<tool>/model-map.json` (data, not code); kit-owned destinations (`AGENTS.md`, `.claude/commands/visp-*.md`, `.github/copilot-instructions.md`) are denylisted.
9. **Handoff/output** (`src/handoff/handoff-protocol.ts`, `src/output/markdown-writer.ts`) — all orchestration output is deterministic delimited text (`BEGIN_VISP_*` blocks). `renderHandoff`'s no-options output must stay byte-identical (tests depend on it); new content rides on optional params.

### Key conventions

- **Types + zod schemas + defaults change together** (`types.ts`, `session-manager.ts`, `defaults.ts`); new persisted fields use `.optional()`/`.default()` so legacy files keep parsing.
- **Degrade, never crash**: missing binaries, dead servers, corrupt JSON stores → warning + empty/null/fallback. Corrupt store files reset to empty with a warning.
- **No shell interpolation**: all subprocess work is `execFile` with argument arrays; validation commands run only from a detected allowlist.
- Adding/changing a tool profile touches four places: `ToolProfile` union (`types.ts`), zod enums (`session-manager.ts`), Commander `.choices()`, and `profileInstructions` (`handoff-protocol.ts`) — plus the installer manifest and `templates/<tool>/` if assets apply.
- Phase-2 seams that remain typed-only: `McpBridge`, `SemanticMemoryProvider` semantic backends. Don't collapse them or add their runtime deps.
- Tests use fixture-based fakes: `tests/helpers/visp-shim.ts` (fake `visp` binary; tests prepend its dir to PATH or pass `binary:`) and `tests/helpers/mock-memory-server.ts` (node:http). No real visp-kit or llm-memory in CI. **Shims don't validate CLI flags — after changing bridge invocations, live-test against the real `visp` binary** (installed in this environment); that's how three real bugs were caught.

## Working on this repo: the Visp Kit gated workflow

This repo dogfoods visp-kit in **strict mode** — the real `visp` binary is installed and `.visp/` is initialized. Follow `AGENTS.md`: `visp status` → `visp policy validate` → `visp gate implement --task <id>` must allow before editing → implement only the selected task → `visp done --task <id>`. Practical quirks learned building features 002–007:

- The `visp` CLI takes task ids as **`--task <id>`, never positional** — a positional id is parsed as a *path* and returns an unrelated error.
- Scaffold commands (`clarify`/`spec`/`plan`/`tasks`) emit TBD templates; you author both the `.json` **and** the matching `.md`, and `traceability.json` must list every REQ/AC/task before `--validate` passes.
- **Stage/commit files before `visp done`** — its verify step diffs git and fails on purely-untracked new files.
- `visp done` does not advance task statuses in `task-graph.json`; update them to `verified` by hand or `visp next` loops.
- Per-task commit convention: `feat(visp-hyper): complete F00X T00Y <title>`.
- `visp status` reports `initialized: true` for **any** `.visp/` directory (even one visp-hyper's own init created); real-kit detection requires probing `.visp/policy.json`/`project.json`.

## AGENTS.md vs. this repo (important)

`AGENTS.md` / `AGENTS.visp.md` describe the strict Visp-Kit gated workflow using the separate `visp` binary. Do not confuse `visp <cmd>` (external kit governance) with `visp-hyper <cmd>` (this project's CLI). Since this working directory has an initialized kit, the gates above apply to changes here.
