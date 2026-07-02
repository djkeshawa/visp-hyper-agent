---
description: Fan out the current visp-hyper pipeline's parallel tasks to subagents.
---

Run the following via Bash:

```
visp-hyper next
```

If the output includes a `BEGIN_VISP_WORKFLOW_DIRECTIVE` block:

1. For each task in a `parallel:` tier, spawn a separate implementer subagent via
   the Task tool. Give each subagent its task's `BEGIN_VISP_TASK_ACTION` block
   verbatim; it must stay strictly inside that task's allowed_files and run the
   listed validation commands.
2. After the subagents return, run `visp-hyper checkpoint --task <id>` yourself,
   sequentially, in exactly the order the directive lists. Do not checkpoint
   concurrently.
3. Do not start a later tier until every earlier task reports PASSED.

If no directive prints, follow the single action block as usual — the pipeline is
sequential.
