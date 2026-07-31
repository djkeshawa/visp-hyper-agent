# ADR 0003: Hyper Owns the Unified `visp` Verb Surface

- **Status:** Proposed
- **Decision date:** 2026-07-31
- **Scope:** The single developer- and agent-facing command vocabulary across Kit, Hyper, and Memory
- **Extends:** `docs/adr/0001-kit-is-authoritative.md`, `docs/adr/0002-direct-entry-points-are-kitless-only.md`
- **Workspace decision:** D-106

## Context

Visp ships three products with three command vocabularies. A developer, and every AI coding tool
driving them, currently faces:

| Surface | Count |
|---|---|
| Kit CLI (`visp`) | 31 commands |
| Hyper CLI (`visp-hyper`) | 16 commands |
| Memory CLI (`visp-memory`) | ~30 commands |
| visp-dev CLI | 3 commands |
| **MCP tools** | **48** — `hyper_*` (12) + `memory_*` (36), in two namespaces |

A complete Claude Code setup installs **11 slash commands under two prefixes**: `/visp-feature`,
`/visp-task`, `/visp-fix`, `/visp-review`, `/visp-pr` from Kit, and `/hyper-run`, `/hyper-next`,
`/hyper-checkpoint`, `/hyper-review`, `/hyper-remember`, `/hyper-fanout` from Hyper.

Six command names collide between Kit and Hyper with materially different authority: `init`, `next`,
`doctor`, `review`, `status`, `hooks`. The most dangerous pair is `review` — `visp review` is a
deterministic verdict, while `visp-hyper review` is explicitly local evidence that grants nothing
(ADR 0002). A model that conflates them will treat advisory output as a gate result, which is the
precise failure ADR 0001 exists to prevent.

The vocabulary problem is therefore not merely ergonomic. Surface fragmentation is a correctness risk
for the authority boundary.

Two constraints bound any solution:

1. **The responsibility matrix.** `planning/architecture-boundary.md` assigns workflow authority to
   Kit, and one-command setup and compatibility to visp Dev. Neither may be relocated.
2. **visp Dev must not become an engine.** Its roadmap goal is "one understandable, installable public
   alpha without creating another policy, workflow, evidence, Memory, or orchestration engine," and its
   own README states: "Visp Dev decides nothing... If it ever starts to, it has become a second engine
   and the boundary has failed." Putting the runtime vocabulary there would also make the installer
   runtime-critical and destroy its role as an independent witness to installed bytes.

The obvious objection to a unified surface is that it looks like a fourth vocabulary layered over three
— adding confusion rather than removing it, and quietly acquiring authority as it decides what each
verb means.

## Decision

Adopt a single verb vocabulary, owned by Hyper, exposed as `visp`.

### A dispatcher, not an engine

The unified surface maps a verb to exactly one owner and delegates. It computes nothing, merges no
verdicts, holds no workflow state, and stores no evidence. One rule keeps this true:

> **Any verb requiring more than one underlying call routes to Hyper.**

Sequencing is Hyper's owned capability — "Kit decides. Hyper presents and coordinates." So a composite
verb is not the dispatcher orchestrating; it is the dispatcher handing the whole request to the layer
whose job that already is. The dispatcher never sequences and never decides.

This is why the surface belongs to Hyper rather than to visp Dev or a new package: Hyper already owns
protocol negotiation and normalization, host capabilities and installed assets, and session-scoped
Memory adapters. A unified vocabulary is presentation, which is Hyper's half of the core principle.
It also adds no fifth product, which `planning/product-map.md` discourages.

### The verbs

| Verb | Developer intent | Owner |
|---|---|---|
| `visp setup` | get me working | visp Dev |
| `visp doctor` | is anything broken | visp Dev (aggregates all three diagnostics) |
| `visp new "<goal>"` | I want to build this | Hyper → Kit `feature`/`clarify`/`spec` |
| `visp plan` | break it down | Hyper → Kit `plan`/`tasks`/`context` |
| `visp next` | what now | Hyper → Kit `next` |
| `visp work` | do the next task | Hyper `run` |
| `visp check` | is my work correct | Hyper → Kit candidate/`verify`/`review`, no state change |
| `visp save` | record the evidence | Hyper `checkpoint` |
| `visp handoff` | get it ready to hand over | Hyper → Kit `reconcile`/`pr`/`done` |
| `visp status` | where am I | Kit `status` (authoritative) |
| `visp recall "<q>"` | what do we already know | Memory |
| `visp learn` | remember this session | Hyper reviewed path → Memory |
| `visp cockpit` | show me the state | Hyper (Phase 9's P9-03) |

`visp doctor` aggregates diagnostics, not verdicts; reporting three tools' health is visp Dev's
documented compatibility role and creates no authority.

**`ship` was renamed `handoff`.** As drafted it meant "make the PR", which the standing boundary lists
as out of scope and Kit's own host instructions forbid. Kit's `pr` command generates a deterministic
summary; it opens nothing. A test asserts the commands these verbs can spawn contain no git-write and
no network call.

**`check` records evidence but takes no workflow-state action** — no implement-marker clear, no
task-status advance, no checklist tick. Kit offers only a real mode that writes all three and a
`--dry-run` that always reports success (`verify.workflow.ts:714`), so this needs a new
`--no-status-update` mode in Kit. The writes live inside Kit's workflows; Hyper cannot suppress them
from outside.

**`cockpit` is the thirteenth verb.** Phase 9's P9-03 creates the command. It is read-only by design
and computes no verdict, so it takes no authority — and deciding it here stops Phase 9 shipping a
command the vocabulary has no room for.

### Porcelain and plumbing

The full ~80 commands remain reachable verbatim through `visp kit <cmd>`, `visp hyper <cmd>`, and
`visp memory <cmd>`. Nothing is removed; the thirteen verbs are porcelain over unchanged plumbing.

### One vocabulary for both audiences

The MCP surface mirrors the thirteen verbs 1:1 as `visp_*` tools. A developer types `visp check` and the
model calls `visp_check`. This is the change that retires the `visp review` / `hyper_review` authority
confusion: there is one `visp_check`, and it routes correctly by construction rather than by the model
remembering which prefix grants what.

Memory's own MCP server registers alongside rather than being proxied, so its 36 tools stay reachable
and Memory keeps sole authority over how durable memory is governed. Only the three or four memory
operations that genuinely belong in the task loop are surfaced as `visp_*` verbs.

### The binary name

Kit releases the `visp` binary; its CLI becomes `visp-kit`. A unified top-level vocabulary is
impossible while one of the three layers owns the top-level name. `visp` must denote the product, not
the gate engine. See visp-kit ADR 0005.

`visp-hyper` remains as an alias through the migration.

## Consequences

- A developer learns thirteen verbs instead of roughly eighty commands; a model sees thirteen tools instead
  of forty-eight across two namespaces.
- The six Kit/Hyper name collisions stop being reachable from the primary surface, removing the
  advisory-versus-authoritative confusion at its source.
- Authority is unchanged. Kit still decides; Hyper still presents and coordinates; Memory still governs
  durable memory; visp Dev still only installs. No verb creates permission that its owner withheld.
- Hyper takes on the porcelain, growing its responsibility as the presentation layer without acquiring
  workflow authority — the same split ADR 0001 already draws.
- Breaking change: `visp <kit-command>` stops working and becomes `visp-kit <kit-command>` or
  `visp kit <kit-command>`. This is cheapest before the public alpha; after it, it breaks real users.
- Host integration assets change shape: eleven slash commands under two prefixes collapse toward the
  verb set, which invalidates conformance fixtures for every host and requires a re-pin.
- Renaming a published binary requires new Kit and Hyper releases and a recorded registry decision.

## Alternatives considered

**visp Dev wraps everything.** Rejected. It contradicts visp Dev's stated non-engine role, makes the
installer runtime-critical, and destroys its function as an independent witness to installed bytes —
a package cannot attest to bytes it ships itself. Bundling Kit and Hyper as pinned dependencies is
fine; owning the runtime vocabulary is not.

**A new fifth package for the porcelain.** Rejected. `planning/product-map.md` discourages adding a
product, and Hyper's existing ownership of presentation already fits.

**Proxy Memory's tools through Hyper for one namespace.** Deferred. It would give a single namespace
but require Hyper to re-implement retrieval semantics it does not own, and would drop 36 tools to
whatever subset Hyper proxies. Start side-by-side; revisit only for task-loop operations.

**Keep three vocabularies and document them better.** Rejected. Documentation does not fix a model
conflating `visp review` with `hyper_review`; only removing the ambiguous surface does.
