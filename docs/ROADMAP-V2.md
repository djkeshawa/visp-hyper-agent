# Visp Hyper Agent — Roadmap v2 (post-M6, debate-refined)

## Context

M1–M6 of the original vision are shipped (163 tests, features 002–007 built through the
gated workflow itself). This roadmap was first drafted from a competitive analysis
(June 2026), then **stress-tested by an adversarial two-agent debate** (champion vs.
adversary, two rounds). The two sides converged; this document is the synthesis.

### What the debate settled

**The moat is real but much narrower than v2 originally claimed.** Not three moats —
one: **session-time, cross-tool, fail-closed gating.**
- It is *structurally* hard to absorb: no single vendor will ship neutral enforcement
  that blocks its own agent across competitors' tools, and git pre-commit/CI gates sit
  below the tool layer entirely. Platforms ship hook *primitives* (which lower our build
  cost); they don't ship adversarial *policy*.
- It is distinct from GitHub branch protection (post-hoc) — the niche is enforcement
  *before tokens are burned*, mid-session.

**Honest downgrades from the original framing:**
- "Moat" → *incentive-blocked territory*: a window, not a wall. Platform absorption of
  these ideas is the **best realistic outcome** for a solo project, not the threat.
- Workflow-integrated memory: the *design* is right (deterministic firing points beat
  recall-on-demand), but hooks + Mem0 can approximate it; it is not a business by
  itself. Keep the design, drop it as a pillar.
- Evidence-gated routing: the asymmetric quality-first *rule* (downgrades earned at
  ≥90% first-attempt pass over ≥3 samples; failures escalate instantly + quarantine) is
  genuinely novel — but it's an **idea best monetized as a publication**, not a
  defensible telemetry product (cold start, n=1 data, advisory-only).
- The three-repo install (TS CLI + TS kit + Python server) is an adoption killer.
  Quick-mode ceremony as an afterthought indicts the strict workflow's cost.

**Success metric (realistic, solo OSS):** meaningful downloads + one circulating
writeup within two months — or a cheap, documented "no" that ends the bet honestly.
Reputation, leverage, and ideas absorbed upstream count as wins.

---

## The plan

### Month 1 — The Wedge (v0.2): one package, one pitch, zero config

Extract the fail-closed gate engine into a single `npx`-installable entry — no Python,
no mandatory visp-kit, file-memory default. One pitch: *"your agent's work is
mechanically scope-checked and only advances on verified evidence."* The demoable
"it actually said no" moment is the product.

Contents (consolidates A1/B1/C1/C3 from the pre-debate draft):
1. **Evidence-gated checkpoint loop** — the existing pipeline engine + checkpoint
   verify/review advancement, runnable without visp-kit.
2. **Quick mode as the DEFAULT ceremony level** — auto single-task graph, scope +
   evidence gates still enforced; strict visp-kit workflow becomes the opt-in
   "reference backend" for power users.
3. **Loose plan-file readers** instead of formal adapters — plain markdown task lists,
   GitHub Spec Kit, and OpenSpec artifacts read into the same task-graph shape
   (graceful degradation where a format lacks gates; hyper's own scope checks + git
   hook still apply).
4. **Enforcement surfaces first-class for every tool**: Claude Code PreToolUse hooks,
   **git pre-commit scope gate, CI gate** — the absorption-proof, tool-agnostic layer.
5. **MCP server mode** (pulled forward from v0.4) so Cursor/Windsurf/anything work on
   day one alongside slash commands.
6. 5-minute demo repo + video showing: blocked gate → exact next command → checkpoint
   pass → advance.

### Month 2 — The Evidence (v0.3): publish or perish, dated

7. **The routing study (D2), now a dated deliverable**: same task set, cheap tier
   with/without the harness; first-attempt verify pass rate + token cost. Publish the
   writeup **even if negative** — a negative result kills the thesis cheaply and is
   still circulating content. This item pays off in every branch.
8. **Shipped priors, not infrastructure (D1-lite)**: routing defaults derived from the
   study baked into the wedge as advisory tiers. No global telemetry store.

### Months 3–6 — Traction-gated only

Proceed on items below **only in response to inbound demand/issues**; otherwise stop
and re-plan from what the downloads and writeup reception say.
9. Richer resume deltas — `visp-hyper resume` now reprints the handoff, required
   read status, latest checkpoint, current task action, and git diff file list;
   the next step is exact checkpoint-to-current diffing if users ask for it.
10. `visp-hyper doctor` — one-command validation of the enforcement chain.
11. Hardening: live-binary contract tests against pinned visp-kit in CI, telemetry/
    registry pruning, Windows audit.
12. Memory backend adapter (Mem0/OpenMemory) — **only if inbound demand names it**;
    the deterministic firing points (task-scoped recall, before-change warnings,
    failure → gotcha distillation) remain the differentiated layer and are
    backend-independent by design. Local failure-pattern memory is already in
    place; the backend adapter should mirror those records rather than replace
    them.

## Killed / deferred (with reasons)

| Item | Verdict | Why |
|---|---|---|
| Formal spec-format adapter framework (old C1) | Replaced | Loose plan-file readers in the wedge deliver the value at a fraction of the maintenance surface |
| Memory backend adapters now (old C2) | Deferred | Integrating with competitors before users exist; demand-gated (item 12) |
| Cross-project global telemetry store (old D1) | Killed | Infrastructure for users who don't exist; shipped priors suffice |
| Subagent fleet templates as a pillar | Demoted | Claude Code ships subagents natively; ours remain bundled config, not product |
| llm-memory as the promoted path | Demoted | File memory is the blessed default; llm-memory stays the reference SemanticMemoryProvider for power users |
| Strict workflow as the entry point | Inverted | Quick mode is the front door; strict mode is the power-user backend |

## Non-goals (unchanged)

- Competing with Mem0/Letta on memory storage, or Spec Kit/OpenSpec on spec authoring.
- Any LLM calls from visp-hyper; orchestration stays deterministic.
- Automatic model switching — directives remain advisory.

---

## Appendix: debate record (condensed)

- **Champion round 1**: moats survive absorption structurally (cross-tool enforcement,
  state-machine-owned memory firing, vendor-incentive-misaligned routing); but OpenSpec
  adapter must come earlier, D2 must be dated, three-repo install unaddressed.
- **Adversary round 1**: features-not-moats for a solo dev (no distribution/community/
  data); adoption math fatal; extract one wedge (standalone checkpoint loop), publish
  evidence month 2, traction-gate everything else; absorption is the best outcome.
- **Round 2 convergence**: both sides independently specified nearly identical plans —
  the wedge package (quick-default, plan-file readers, git/CI + MCP first-class),
  dated D2 with shipped priors, the same kill list, visp-kit as opt-in strict backend.
  Residual disagreement (memory state-machine exclusivity vs. hook-approximability)
  resolved by demand-gating the memory track.
