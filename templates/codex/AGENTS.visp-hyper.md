# Working with visp-hyper

> Discovery: Codex does not auto-load this file. Add this line to your `AGENTS.md`
> so agents find it: `See AGENTS.visp-hyper.md for the visp-hyper session protocol`.

This project uses **visp-hyper**, a local-first companion that selects context and
prints an Agent Handoff Protocol telling you how to run a disciplined session.

## Flow

1. Start every task with `visp work "<goal>"`.
2. Read the printed handoff and action block, then obey them exactly: read the
   required files, stay within the allowed/forbidden file scopes, and run the
   listed validation commands before considering the task done.
3. If a BLOCKED block prints, run the named next command instead of coding.
4. Run `visp save --task <id>` to collect local validation evidence.
   Hyper checkpoint results are local evidence only.
   Strict progression and remediation require the exact current ready Kit action.
   In a genuinely Kit-less workflow, local evidence may guide local progression.
5. Record learnings with `visp-hyper remember --summary "<what was learned>"`.
   A learn proposal records session learnings and does not complete a Kit task.

## Role passes

Use a bounded read-only subagent for the scout or challenger pass when it adds
useful parallelism. A sequential pass in the current session remains the safe
fallback.

1. **Scout pass (read-only).** Gather the files and evidence the task needs. Read
   every path under `required_reads`, inspect the files named in the action block,
   and note the exact paths you will edit and validate. Cite the paths you found;
   do not edit anything in this pass.
2. **Implement pass.** Edit only the files inside the allowed scope from the action
   block, run the listed validation commands, and report the evidence (commands run
   and their result). Then run `visp save --task <id>` to record it.
