# visp-hyper-agent

Local-first companion workflow controller for Codex, Claude Code, GitHub Copilot, OpenCode, and similar AI coding tools.

Visp Hyper Agent does not replace coding agents. It prepares compact context, reads Visp-Kit and local Visp-Memory artifacts, prints an LLM-readable handoff protocol, and gives the active coding tool a disciplined session workflow.

## Commands

- `visp-hyper init` creates `.visp/hyper/config.json`, `.visp/hyper/state.json`, and `.visp/hyper/current/`.
- `visp-hyper start "<goal>"` starts a guided session, writes current session files, and prints `BEGIN_VISP_AGENT_HANDOFF`.
- `visp-hyper next` prints the next bounded action block.
- `visp-hyper status` reports session metadata, generated files, checkpoint/review state, and memory status.
- `visp-hyper checkpoint` appends git diff stat and changed files to `.visp/hyper/current/checkpoints.md`.
- `visp-hyper review` writes `.visp/hyper/current/review-report.md` and prints `BEGIN_VISP_REVIEW_RESULT`.
- `visp-hyper remember` writes `.visp/memory/session-history/<session-id>.md`.

## Install Locally

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
node /path/to/visp-hyper-agent/dist/index.js --project /path/to/project init
node /path/to/visp-hyper-agent/dist/index.js --project /path/to/project start "implement offline note sync" --tool codex
```

## Example Codex Workflow

From inside a target repository:

```bash
visp-hyper start "implement offline note sync" --tool codex
```

The command writes:

```text
.visp/hyper/current/session.md
.visp/hyper/current/context-pack.md
.visp/hyper/current/memory-pack.md
.visp/hyper/current/quality-gates.md
.visp/hyper/current/agent-instructions.md
.visp/hyper/current/handoff.json
```

It also prints a handoff block shaped like:

```text
BEGIN_VISP_AGENT_HANDOFF
version: 0.1
session_id: vh_20260607_abcd1234
goal: implement offline note sync
phase: implementation
tool_profile: codex
tool_profile_label: Codex

required_reads:
  - .visp/hyper/current/session.md
  - .visp/hyper/current/context-pack.md
  - .visp/hyper/current/memory-pack.md
  - .visp/hyper/current/quality-gates.md
  - .visp/hyper/current/agent-instructions.md

workflow:
  1. Read the required files.
  2. Inspect only the relevant files listed in the context pack.
  3. Create a concise implementation plan.
  4. Implement the smallest safe change.
  5. Add or update tests where appropriate.
  6. Run validation commands.
  7. Run `visp-hyper review`.
  8. Run `visp-hyper remember`.
END_VISP_AGENT_HANDOFF
```

After implementation:

```bash
visp-hyper checkpoint
visp-hyper review
visp-hyper remember --summary "Implemented offline note sync."
```

## File Layout

Runtime files:

```text
.visp/
  hyper/
    config.json
    state.json
    current/
      session.md
      context-pack.md
      memory-pack.md
      quality-gates.md
      agent-instructions.md
      handoff.json
      checkpoints.md
      review-report.md
  memory/
    project-summary.md
    architecture-decisions.md
    known-risks.md
    session-history/
```

Source modules:

- `src/cli/commands/` contains command behavior.
- `src/core/` contains config, state, and shared types.
- `src/context/` contains deterministic context selection.
- `src/kit/` reads Visp-Kit artifacts.
- `src/memory/` provides file-backed memory and future provider seams.
- `src/handoff/` renders the Agent Handoff Protocol.
- `src/quality/` analyzes git diffs for review warnings.

## Tool Profiles

Supported profiles:

- `generic`
- `codex`
- `claude-code`
- `copilot`
- `opencode`

`--tool` changes handoff metadata and profile wording while preserving the shared protocol structure. Unknown values are rejected by the CLI.

## Current Limits

- Local-first and file-based only.
- No external LLM API calls.
- No database, embeddings, semantic reranking, or MCP runtime dependency.
- Review checks are deterministic path-based warnings, not full static analysis.
- Visp-Kit artifacts are consumed from `.visp/`; this tool does not generate Visp-Kit specs or plans.

## Phase 2 Roadmap

- Add an `LlmMemoryProvider` adapter once the local-first `llm-memory` API is stable.
- Add ArcadeDB-backed recall and semantic search behind the typed memory seams.
- Add validation command detection/execution adapters.
- Add branch-aware session tracking.
- Add MCP server mode for compatible coding tools.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```
