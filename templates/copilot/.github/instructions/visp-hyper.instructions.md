# visp-hyper instructions

This project uses **visp-hyper**, a local-first companion that selects context and
prints an Agent Handoff Protocol describing how to run a disciplined session.

## Flow

1. Start each task with `visp-hyper run "<goal>"`.
2. Read the printed handoff and action block and obey them exactly: read the required
   files, stay within the allowed/forbidden file scopes, and run the listed validation
   commands before treating the task as done.
3. If a BLOCKED block prints, run the named next command instead of coding.
4. Advance between tasks with `visp-hyper checkpoint --task <id>`; on FAILED, fix only
   the reported findings and re-run.
5. End the session with `visp-hyper remember --summary "<learnings>"`.

## Cost routing

Spend the fewest tokens for the most accurate result. Reserve the strongest model for
net-new logic and design decisions; lean on cheaper contexts for scanning and
mechanical edits.
