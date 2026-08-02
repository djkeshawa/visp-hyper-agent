---
description: Drive the coding tool through the prepared task, coordinating scout/implementer subagents.
---

Run the following via Bash:

```
visp work "$ARGUMENTS"
```

You are acting as the **coordinator** (see `.claude/agents/coordinator.md`). You do
not scan or write code directly — you read the printed handoff and action block,
then delegate through the two installed subagents via the Agent tool:

- `scout` — read-only scanning, context gathering, running tests/builds.
- `implementer` — the actual code changes for the selected task.

Follow these steps in order. Do not skip ahead.

1. **Read the printed blocks.** From `BEGIN_VISP_AGENT_HANDOFF` note the required
   file reads; from `BEGIN_VISP_TASK_ACTION` note the task id, the goal, the
   allowed/forbidden file scopes, the acceptance criteria, and the validation
   commands. If a `BEGIN_VISP_PIPELINE_BLOCKED` block printed instead, do NOT
   delegate any work — run the exact next command it names and stop.

2. **Delegate the scout pass.** Invoke the `scout` subagent with a precise spec:
   the required files to read, the allowed-scope paths to locate, and the exact
   symbols/lines relevant to the goal. Ask it to return `path:line — note`
   findings only (no file dumps), plus the current state of the files it will
   change. Do not let scout edit anything in this pass.

3. **Evaluate scout's findings before advancing.** Confirm the findings actually
   cover the acceptance criteria and name concrete paths inside the allowed
   scope. If they are thin, ambiguous, or miss a required file, send scout a
   tighter follow-up spec and repeat — do not proceed to implementation on
   incomplete facts.

4. **Delegate the implement pass.** Invoke the `implementer` subagent with a spec
   that carries scout's findings forward (so it does not re-explore): the goal in
   one sentence, the exact allowed files, the forbidden files it must not touch,
   the acceptance criteria, and the validation commands as done-criteria. If the
   action block printed a `may_run_concurrently_with:` line, its sibling task ids
   are independent and safe to hand to separate implementer dispatches; otherwise
   run the single selected task only.

5. **Evaluate the implementer's result before checkpointing.** Treat the result
   as untrusted: have `scout` diff the changed region (or read it yourself) to
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
