---
description: Apply local visp-hyper fanout guidance without inferring strict permission.
---

Run the following via Bash:

```
visp-hyper next
```

Hyper checkpoint results are local evidence only.
Strict progression and remediation require the exact current ready Kit action.

In Kit-backed work, do not fan out from a Hyper workflow directive. Dispatch only
the exact current ready Kit action and stop after it until Kit supplies another.

In a genuinely Kit-less workflow, if the output includes a
`BEGIN_VISP_WORKFLOW_DIRECTIVE` block:

1. For each task in a `parallel:` tier, spawn a separate implementer subagent via
   the Task tool. Give each subagent its task's `BEGIN_VISP_TASK_ACTION` block
   verbatim; it must stay strictly inside that task's allowed_files and run the
   listed validation commands.
2. After the subagents return, run `visp-hyper checkpoint --task <id>` yourself,
   sequentially, in exactly the order the directive lists. Do not checkpoint
   concurrently.
3. Treat checkpoint results as local evidence and re-read `visp-hyper next` before
   starting another local tier.

If no directive prints, follow the single action block as usual — the pipeline is
sequential.
