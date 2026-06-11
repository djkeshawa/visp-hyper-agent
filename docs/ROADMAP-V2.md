# Visp Hyper Agent — Roadmap v2 (post-M6)

## Context

M1–M6 of the original vision are shipped: kit bridge, llm-memory provider, pipeline engine,
tool asset installer, telemetry + quality-first routing, and skill harvesting (163 tests,
features 002–007 built through the gated workflow itself).

The competitive analysis (June 2026) found a crowded field — GitHub Spec Kit, OpenSpec,
BMAD, Kiro on the workflow side; Mem0/OpenMemory, Letta, Supermemory on memory — but
three genuinely differentiated assets in this stack:

1. **Mechanical enforcement** — deterministic gates + evidence-gated task advancement,
   where every competitor is advisory-only.
2. **Workflow-integrated memory** — recall and distillation that fire automatically at
   pipeline moments (task scope, checkpoint failure, before-change), not on agent whim.
3. **Evidence-gated model routing** — local pass-rate telemetry deciding when a cheap
   tier has *earned* a task class; nobody else does this.

v2 strategy: **double down on the three moats, open everything else.** Stop competing on
spec formats and memory storage; become the enforcement + intelligence layer that works
on top of whatever artifacts and memory store the user already has.

Honest framing of the two design beliefs this roadmap revisits:

- *"A separate kit gives a more enforced workflow"* — true, but the enforcement lives in
  the gate engine + hooks (~20% of visp-kit), not in owning the spec format (~80%,
  undifferentiated vs GitHub/AWS distribution). Keep the engine, open the format. Also:
  mechanical enforcement currently reaches only Claude Code (PreToolUse); git pre-commit
  and CI gates are the genuinely platform-agnostic enforcement surfaces and become
  first-class in v2.
- *"Platform-agnostic memory matters because not all tools have it"* — the user-need is
  real (memory is moat data; tool lock-in is a legitimate fear) but the *category* is
  already served by MCP-based incumbents. The defensible asset is workflow-integrated
  recall/distillation, so the memory backend becomes swappable while the integration
  intelligence stays ours.

---

## Track A — Adoption blockers first

### A1. Risk-proportional ceremony (`visp-hyper quick`)
The #1 reason a real user would turn this off: strict-mode artifact authoring costs as
much as implementation for small changes (measured while dogfooding features 002–007).
- New fast path: `visp-hyper quick "<small change>"` — auto-generated single-task graph,
  clarification defaults accepted, spec/plan skipped, but **checkpoint evidence and scope
  gates still enforced**. Maps to visp-kit's `relaxed` strictness; `run` keeps strict.
- Policy-driven escalation: task risk (files touched, dependency changes, blocked-path
  proximity) can force a quick task up into the full workflow.
- Success metric: a one-file fix goes idea → verified commit in under 2 minutes of
  overhead while still being mechanically scope-checked.

### A2. Ship it
- npm publish (`npx visp-hyper init --tool claude-code` quickstart), versioned with
  visp-kit compatibility ranges.
- Docs site from existing README/CLAUDE.md content + a 5-minute demo repo/video showing
  the blocked-gate → next-command → checkpoint loop.
- Windows path/exec audit (everything is execFile + node:path already; verify).

## Track B — Enforcement everywhere (moat #1)

### B1. Cross-platform mechanical gates
- `init --tool <any>` offers visp-kit's **git pre-commit** scope hook and **CI gate**
  (`visp hooks git` / `visp hooks ci`) for every tool, not just claude-code — the
  pre-commit hook blocks out-of-scope changes for Codex/Copilot/anything.
- `visp-hyper doctor`: one command validating the whole enforcement chain — visp binary,
  kit state, hooks installed, llm-memory health, tool assets fresh, telemetry/routing
  stores valid.

### B2. Session resume protocol
`visp-hyper resume` — re-print the current task's handoff + action block with a delta
since last checkpoint (changed files, remaining acceptance criteria). Cheap re-grounding
after context-window resets; chronic pain in long agent sessions, and a natural fit for
the deterministic-state design.

## Track C — Open the walled garden (interop)

### C1. Spec-format adapters
- `KitSource` abstraction over today's visp-kit reader: adapters that read **GitHub
  Spec Kit** and **OpenSpec** artifacts into the same task-graph/context shapes the
  pipeline engine consumes. Gates degrade gracefully where a format lacks equivalents
  (no policy engine → hyper's own scope checks + git hook still apply).
- Positioning shift: "the evidence-gate and routing layer for spec-driven development"
  — works with the SDD tool you already use; visp-kit remains the reference (and
  strictest) backend.

### C2. Memory backend adapters
- `Mem0Provider` (OpenMemory MCP or REST) implementing the existing `MemoryProvider`/
  `SemanticMemoryProvider` seams; llm-memory stays the reference implementation.
- The integration intelligence (task-scoped recall, before-change warnings, failure →
  gotcha distillation, skill mirroring) is backend-independent — that is the product.

### C3. MCP server mode
- `visp-hyper serve --mcp` exposing hyper_run/next/checkpoint/review/remember/report via
  the typed `McpBridge` seam (official MCP TS SDK as optional/lazy dependency). Unlocks
  Cursor, Windsurf, and anything MCP-capable without slash-command support.

## Track D — Make routing actually fire (moat #3's cold-start fix)

### D1. Cross-project telemetry
Per-project evidence (≥3 samples per task class) means most projects never accumulate
enough data to downgrade — the headline cost feature rarely fires. Fix:
- Opt-in global store (`~/.visp-hyper/telemetry.json`) aggregating attempts across
  projects, keyed by task class + tier; project-local evidence overrides global.
- Shipped priors: defaults derived from dogfooding data so routing gives sane advice
  from session one.

### D2. Publish the routing results
Run a controlled comparison (same task set, cheap tier with/without the harness; track
first-attempt pass rate + tokens) and write it up. The quality-first routing loop is the
most publishable idea in the stack — it can travel further than the codebase and is the
best marketing asset available.

## Track E — Hardening

- Contract tests against a pinned real visp-kit version in CI (the shim missed three
  real CLI-flag bugs; live-binary tests are the proven catch).
- Telemetry/registry pruning (size caps, archival) for long-lived projects.
- Failure-pattern memory: verify/review failure signatures stored as `antipattern`
  memories and surfaced in before-change warnings (closes the loop designed in M5).
- Skill quality: usage-weighted ordering in handoffs; `visp-hyper skills prune` applying
  the report's prune flags with confirmation.

---

## Sequencing

| Phase | Items | Rationale |
|---|---|---|
| v0.2 | A1, A2, B1 | Remove the adoption blockers; make enforcement the cross-platform story |
| v0.3 | C2, B2, D1 | Swappable memory + resume + routing that actually fires |
| v0.4 | C1, C3 | Open the spec format; reach non-slash-command tools |
| ongoing | D2, E | Evidence publication and hardening |

## Non-goals (explicit)

- Competing with Mem0/Letta on general-purpose memory storage.
- Competing with Spec Kit/OpenSpec on spec authoring UX or artifact richness.
- Any LLM calls from visp-hyper; all orchestration stays deterministic.
- Automatic model switching — directives remain advisory; tools own model selection.
