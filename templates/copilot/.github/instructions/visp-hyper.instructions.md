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

## Role passes

Tools with native subagent support (such as Claude Code) may run the scout pass in
a dedicated subagent; here you run both passes sequentially in one session.

Run each task as two sequential passes in the same session — one model can do both.

1. **Scout pass (read-only).** Gather the files and evidence the task needs. Read
   every path under `required_reads`, inspect the files named in the action block,
   and note the exact paths you will edit and validate. Cite the paths you found;
   do not edit anything in this pass.
2. **Implement pass.** Edit only the files inside the allowed scope from the action
   block, run the listed validation commands, and report the evidence (commands run
   and their result). Then run `visp-hyper checkpoint --task <id>` to record it.
