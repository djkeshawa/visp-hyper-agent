# Five-minute quickstart

Watch an out-of-scope commit get physically blocked — and a task verified — in five minutes.

`visp-hyper` never calls an LLM. It reads your project, prints a bounded task contract, installs a real git pre-commit hook, and advances only on local evidence. Everything below runs offline.

## Prerequisites

- Node.js 24+ and `git`
- `visp-hyper` available on your `PATH`. From a clone:

  ```bash
  pnpm install && pnpm build
  # then either `pnpm link --global`, or call `node /path/to/visp-hyper-agent/dist/index.js`
  ```

  The walkthrough writes `visp-hyper`; substitute `node /path/to/visp-hyper-agent/dist/index.js` if you did not link it.

## Step 1 — A scratch project

```bash
mkdir visp-demo && cd visp-demo
git init -b main
cat > package.json <<'JSON'
{
  "name": "visp-demo",
  "version": "0.0.0",
  "private": true,
  "scripts": { "test": "node -e \"console.log('tests ok')\"" }
}
JSON
mkdir src
echo "export const parse = (s) => s.trim();" > src/parser.ts
git add .
git -c user.name="You" -c user.email="you@example.test" commit -m "init"
```

## Step 2 — Start an evidence-gated task

```bash
visp-hyper quick "tighten the parser" --files src
```

`quick` opens a zero-config session scoped to `src`, then prints two blocks. The handoff (`BEGIN_VISP_AGENT_HANDOFF … END_VISP_AGENT_HANDOFF`) is the session contract your coding agent reads. The action block names the one task and its boundaries:

```text
BEGIN_VISP_TASK_ACTION
task: Q001 - tighten the parser
risk: unknown    parallelizable: false
session: vh_20260612_xxxxxxxx

goal:
  tighten the parser

allowed_files:
  - src

done_criteria:
  1. All validation commands exit zero.
  2. Only allowed or expected files changed.
  3. Run `visp-hyper checkpoint --task Q001` and proceed only if it reports PASSED.
END_VISP_TASK_ACTION
```

The `allowed_files` list is the scope. Anything outside `src` is out of bounds for task `Q001`.

## Step 3 — Install the pre-commit guard

```bash
visp-hyper hooks git
# → hooks git: installed .git/hooks/pre-commit
```

This writes a marker-owned `.git/hooks/pre-commit` (carrying `# visp-hyper-guard hook`) that runs `visp-hyper guard --staged` before every commit. A pre-existing foreign hook is never overwritten — you get a warning instead. Re-running reports `updated`.

## Step 4 — The money moment: an out-of-scope commit gets blocked

```bash
mkdir lib
echo "export const r = 1;" > lib/rogue.ts
git add lib/rogue.ts
git -c user.name="You" -c user.email="you@example.test" commit -m "sneak in lib change"
```

`lib/rogue.ts` is outside the task's `allowed_files`, so the hook refuses the commit:

```text
BEGIN_VISP_GUARD_RESULT
scope: Q001
checked: 1 file(s) (staged)
violations:
  - lib/rogue.ts: outside allowed files
status: BLOCKED
END_VISP_GUARD_RESULT
```

The commit exits non-zero and nothing lands. The guard is mechanical: it compares staged paths against the active task's scope plus the blocked-path list (`.env`, secrets, etc.). Blocked paths apply even when no session is active.

## Step 5 — An in-scope change passes, then verify the task

```bash
git reset lib/rogue.ts
echo "export const parse = (s) => s.trim().toLowerCase();" > src/parser.ts
git add src/parser.ts
git -c user.name="You" -c user.email="you@example.test" commit -m "tighten parser"   # passes
```

The staged change is under `src`, so the guard reports `status: PASSED` and the commit lands. Now record verified evidence for the task:

```bash
visp-hyper checkpoint --task Q001
```

In this kit-less project, checkpoint runs the local evidence pipeline (your `test` script + deterministic diff review) and advances only when both pass:

```text
BEGIN_VISP_CHECKPOINT_RESULT
task: Q001
verify: PASSED
review: PASSED
evidence_source: local
status: PASSED
pipeline_complete: true
END_VISP_CHECKPOINT_RESULT
```

`evidence_source: local` means the pass came from running your own commands — not a model's say-so. A failure would print `status: FAILED` with findings and an instruction to fix and re-run.

## Step 6 — Remember the session and read the report

```bash
visp-hyper remember --summary "Tightened parser to lowercase + trim; guard blocked an out-of-scope lib edit."
visp-hyper report
```

`remember` persists the session to `.visp/memory/session-history/` (and to llm-memory when enabled). `report` prints `VISP_HYPER_REPORT … END_VISP_HYPER_REPORT`: per-tier verify+review pass rates, token totals, and any routing quarantines — the evidence behind every cost/quality decision.

## Use from Cursor / Windsurf (MCP)

`visp-hyper serve --mcp` exposes the same workflow as MCP tools over stdio. Point your MCP client at it:

```json
{
  "mcpServers": {
    "visp-hyper": {
      "command": "visp-hyper",
      "args": ["serve", "--mcp", "--project", "/path/to/project"]
    }
  }
}
```

The server advertises seven tools: `hyper_quick`, `hyper_run`, `hyper_next`, `hyper_checkpoint`, `hyper_guard`, `hyper_remember`, and `hyper_report`. Each runs the matching CLI command in-process and returns its output block as text.

## Team memory (optional)

Point a project at a shared [llm-memory](https://github.com/djkeshawa/llm-memory) server so recall and decisions are shared across the team:

```bash
visp-hyper init --memory-endpoint https://memory.yourteam.example:8000 --memory-repo-id your-project
```

Authenticate with the `VISP_HYPER_MEMORY_API_KEY` environment variable (sent as `X-API-KEY`); keys never live in config files. If the server is unreachable, commands warn and fall back to file memory — it is never a hard error.

## Going strict

The walkthrough above used the zero-config `quick` path. For the full gated workflow — policy validation, a real task DAG, and gate evaluation — initialize a [Visp Kit](https://github.com/djkeshawa/visp-kit) project and drive it with `visp-hyper run "<goal>"`. In a kit project, `run` validates policy and evaluates gates, then prints either a per-task handoff and action block or a `BEGIN_VISP_PIPELINE_BLOCKED` block naming the exact next allowed `visp` command. The guard, checkpoint, and memory mechanics you just saw apply identically — just with kit-authored scope instead of `--files`.
