---
description: Drive the coding tool through the prepared task, coordinating scout/mechanic/implementer subagents.
---

Run the following via Bash:

```
visp work "$ARGUMENTS"
```

You are acting as the **coordinator** (see `.claude/agents/coordinator.md`). You do
not scan or write code directly — you read the printed handoff and action block,
then delegate through the three installed subagents via the Agent tool:

- `scout` — navigation only: locates entrypoints, the call path and the affected
  tests by querying the Visp Intel graph. It cannot read, run or edit anything.
- `mechanic` — reading files, running tests/builds, and deterministic edits.
- `implementer` — the actual code changes for the selected task.

Follow these steps in order. Do not skip ahead.

1. **Read the printed blocks.** From `BEGIN_VISP_AGENT_HANDOFF` note the required
   file reads; from `BEGIN_VISP_TASK_ACTION` note the task id, the goal, the
   allowed/forbidden file scopes, the acceptance criteria, and the validation
   commands. If a `BEGIN_VISP_PIPELINE_BLOCKED` block printed instead, do NOT
   delegate any work — run the exact next command it names and stop.

2. **Delegate the scout pass.** Invoke the `scout` subagent with the task id and
   the behavioural question in one sentence. It has six actions and a hard cap of
   12; do not ask it for file contents, test runs or edits — it has no tool for
   any of that. It returns one JSON object.

3. **Cross the handoff boundary.** Write the scout's JSON object verbatim to
   `.visp/hyper/current/scout-findings.json` via Bash, then read
   `visp-hyper://current/scout-findings` back. That read runs Hyper's collector,
   which keeps only rows carrying an intel receipt. Everything else the scout
   said is discarded here and goes no further — do not paste scout prose into any
   later spec.

   - `accepted` — carry those rows forward and only those rows.
   - `rejected` — forward none of it; the listed reasons say why.
   - `unresolved` status with a populated question is a successful run, not a
     failure. Do not re-run it on a stronger model to get a nicer answer.
   - `provider.registered: false` — read this FIRST. Nothing in this project
     provides the scout's `mcp__visp-intel__*` tools, so it had nothing to
     query and its empty result means nothing. Report the missing provider,
     use `mechanic` to locate the code instead, and never record that run as
     evidence that intel had nothing to offer.

4. **Delegate the implement pass.** Invoke the `implementer` subagent with a spec
   that carries the collected scout state forward (so it does not re-explore):
   the goal in one sentence, the accepted entrypoints/path/tests, the exact
   allowed files, the forbidden files it must not touch, the acceptance criteria,
   and the validation commands as done-criteria. If the action block printed a
   `may_run_concurrently_with:` line, its sibling task ids are independent and
   safe to hand to separate implementer dispatches; otherwise run the single
   selected task only.

5. **Evaluate the implementer's result before checkpointing.** Treat the result
   as untrusted: have `mechanic` diff the changed region (or read it yourself) to
   confirm only allowed files changed, then run the listed validation commands and
   confirm they pass. If anything is wrong, send a corrective spec back to
   `implementer` for the specific failure and re-run — do not checkpoint a result
   you have not verified.

6. **Checkpoint.** Run `visp save --task <id>` (via Bash) to collect
   local validation evidence.
   Hyper checkpoint results are local evidence only.
   Strict progression and remediation require the exact current ready Kit action.
   In a genuinely Kit-less workflow, local evidence may guide local progression.

7. **Record learnings.** Run `visp learn "<learnings>"` when the
   handoff requests it.
   A learn proposal records session learnings and does not complete a Kit task.
