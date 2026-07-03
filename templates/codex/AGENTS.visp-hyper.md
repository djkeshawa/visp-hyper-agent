# Working with visp-hyper

This project uses **visp-hyper**, a local-first companion that selects context and
prints an Agent Handoff Protocol telling you how to run a disciplined session.

## Flow

1. Start every task with `visp-hyper run "<goal>"`.
2. Read the printed handoff and action block, then obey them exactly: read the
   required files, stay within the allowed/forbidden file scopes, and run the
   listed validation commands before considering the task done.
3. If a BLOCKED block prints, run the named next command instead of coding.
4. Between tasks, advance with `visp-hyper checkpoint --task <id>`; on FAILED, fix
   only the reported findings and re-run.
5. At the end of the session, persist learnings with
   `visp-hyper remember --summary "<what was learned>"`.

## Cost routing

Spend the fewest tokens for the most accurate result. When your tool supports it,
delegate scanning, searching, and mechanical edits to a cheaper context, and reserve
the strongest model for net-new logic and design decisions.

## Workflow directives

If a `BEGIN_VISP_WORKFLOW_DIRECTIVE` block prints, treat its `parallel:` grouping as
safe-to-reorder, not as a concurrency requirement: execute the tasks in the listed
order and run `visp-hyper checkpoint --task <id>` after each before starting the
next. If a `BEGIN_VISP_ADAPTATION` block prints after a failed checkpoint, follow
its instruction — a remediation task (`R-...`) becomes the current task.
