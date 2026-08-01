# ADR 0004: Cockpit Is a Read-Only Local Presentation Surface

- **Status:** Accepted
- **Decision date:** 2026-08-01
- **Scope:** Phase 9 Cockpit contract, local host, and browser surface
- **Extends:** `docs/adr/0001-kit-is-authoritative.md`, `docs/adr/0003-hyper-owns-the-unified-verb-surface.md`
- **Phase:** P9-03 to P9-05

## Context

Phase 9 makes the existing `.visp/` artifact plane readable without requiring a
person to inspect JSON in a terminal. A browser surface introduces a subtle authority
risk: when an artifact is absent or unreadable, a convenient UI can turn missing data
into an empty table that looks successful. It also introduces local data-exposure and
command-execution risks if the host binds broadly, trusts arbitrary Host headers,
loads remote assets, or turns a displayed recovery command into a button that runs it.

The Cockpit belongs beside Hyper's existing presentation and host-integration
responsibilities, but it must not turn Hyper into another workflow, evidence, review,
or readiness engine.

## Decision

Hyper hosts the Cockpit as a local presentation adapter. The Cockpit quotes validated
artifact facts and computes no verdict, permission, scope, evidence sufficiency,
review outcome, task completion, or pull-request readiness. A value that carries any
of those meanings is displayed only when its source artifact supplied it, with that
path visible beside the value.

### Versioned, fail-visible state

Cockpit API version `1.0` contains exactly nine screens in the recorded navigation
order: Now, Feature, Scope, Assurance, Review, Runs, Memory, Health, and Reference.
Each screen has a nonempty artifact-view array and no aggregate state. Each artifact
is independently discriminated as `present`, `uninitialized`, `missing`, `stale`,
`corrupt`, or `unavailable`.

A present artifact has one or more artifact-attributed scalar values. Every degraded
artifact has a nonempty reason and expected-path provenance; stale and corrupt
artifacts also identify the existing source path. The client renders sibling
artifacts independently and never computes a worst-state badge. A malformed view
fails visibly without hiding valid siblings. Partial failure therefore cannot appear
as either empty success or a wholly present screen.

Provenance paths are runtime-branded, repository-relative POSIX paths below `.visp/`.
Absolute, backslash, empty/dot-segment, control, query, fragment, and percent-bearing
paths are rejected. Memory uses the narrower exact allowlist recorded below.

The contract intentionally provides no separate authority fields. Hyper does not
reinterpret generic artifact values or combine them into a new result.

### Commands are opaque and copy-only

The command palette is an interaction, not a screen. Screen navigation is always
available. Command text is accepted only as an opaque artifact value with a visible
source path. The client may copy it to the clipboard; it cannot execute it. Hyper
hardcodes no fallback command. When no valid command artifact exists, the palette
shows `unavailable` with its reason and expected path.

### Local-only transport and static assets

The host binds exactly `127.0.0.1`, validates the Host header, and authenticates API
and event requests with a fresh per-session token. The client removes the token from
the initial address/history entry, retains it only in memory, authenticates same-origin
state requests, and uses the token for same-origin SSE invalidations. Invalidation
events trigger a fresh state read rather than carrying artifact payloads.
An SSE `open` event also triggers a fresh state read before the UI marks the
connection live, closing the invalidation gap across a reconnect. The connection
badge gives unavailable, reconnecting, and connecting transport states precedence
over state-fetch completion. A successful fetch is labelled live only when it belongs
to the currently open stream epoch.

The host exposes no mutating route, and the browser performs only reads. The Cockpit
opens no outbound connection. Its HTML, CSS, and JavaScript are dependency-free local
assets served under a CSP that permits only same-origin scripts, styles, images, and
connections and denies objects, frames, forms, fonts, media, workers, and manifests.
The document declares `no-referrer`, the static manifest carries the same policy, and
the host emits `Referrer-Policy: no-referrer` because EventSource authentication uses
a query token. Neither inline script/style nor dynamic evaluation is required.

Watcher startup fails if the recursive artifact handle cannot be armed. Runtime root
or artifact watcher failures close stale handles, issue a path-only `.visp`
invalidation, and retry through one delayed timer. Repeated failures keep producing
bounded refresh invalidations, and successful recovery produces another root
invalidation to close the missed-event gap. Run-tail path resolution rejects final
and intermediate symbolic links below the canonical project root, including in-root
aliases, so artifact provenance never cites a different physical file.
Run-event descriptors use non-blocking and no-follow flags where the platform exposes
them, then require a regular file by descriptor metadata before reading. Special files
such as FIFOs are unavailable artifacts and cannot hold an HTTP request waiting for a
writer.

The host resolves the project root once at startup, records its device and inode, and
uses that canonical path for Kit reads, run reads, and watching. Filesystem API reads
check the root identity both before and after the asynchronous read and fail closed if
the canonical directory entry was replaced. Retargeting a caller-supplied root
symlink therefore cannot redirect a running Cockpit. These path checks are local
hardening, not an atomic filesystem snapshot: an adversarial replace-and-restore
between the two checks (an ABA race) is a residual limitation of the portable Node
path API.

### Memory and Runs

Memory is labelled cited and non-authoritative. Phase 9 chooses only the canonical
`.visp/memory/constitution.md`, `.visp/memory/patterns.md`, and
`.visp/memory/project-summary.md` artifact view. This decision creates no dependency
on the separately governed `.visp-memory/` store and assigns no new ownership of the
canonical artifacts to Hyper.

Runs may use host pagination and byte-offset event tails. The UI does not synthesize
missing runs, results, counts, or verdicts.

Run list pages cite their index artifact and use record offsets with explicit `null`
at end-of-list. Event pages cite `events.jsonl`, use byte offsets, and always return
the next byte offset, `rotated`, and an opaque generation. Clients resubmit offset
and generation. That cursor generation hashes the file identity, first record, and a
bounded byte window ending at the returned offset, so ordinary append remains valid
while replacement or same-inode regrowth near the cursor resets reading to byte zero,
marks the response rotated, and replaces the cursor. The generic page types carry
Kit-validated values without restating Kit's run/event schemas. Errors use a fixed
code set, a message bounded to 512 characters, and optional degraded artifact
path/state only.

If the first record is longer than the 64 KiB generation window, the generation hashes
that bounded prefix instead of rejecting the otherwise valid record. The generation
window is replacement evidence, not a schema or record-size limit. If a run list
shrinks below a previously issued page offset, the host returns an explicit terminal
empty page and the browser returns to the nearest still-valid visited offset.

The Cockpit defines no default freshness interval and no universal stale TTL. It
renders `stale` only when the artifact reader receives an explicit caller-supplied
freshness boundary and returns that state.

Before displaying a stored review decision, Hyper checks that the pointer is bound
to the active feature and task and canonical history path, then checks the selected
history record's feature, task, hash, and timestamp identity against that pointer.
Mismatch fails closed as unavailable. This is provenance binding, not a freshness or
workflow-verdict calculation.

Run-event reads are bounded to 1 MiB per response. A complete valid record beyond that
transport window is reported as unavailable because of the display bound, not corrupt.
Complete records are decoded as strict UTF-8; malformed bytes are corrupt rather than
replacement-decoded into potentially schema-valid content.
The browser retains at most 256 records and 2 MiB of UTF-8 serialized event bytes
across refreshes, visibly counts omitted records, and leaves both the source artifact
and byte cursor unchanged.

Phase 9 exposes the command as `visp-hyper cockpit`. The unified `visp cockpit`
spelling remains part of planned Phase 10 and waits for that phase to be explicitly
activated and implemented.

## Consequences

- The Cockpit can expose the artifact plane without acquiring Kit authority.
- Missing, stale, corrupt, uninitialized, and unavailable data remain visible states
  that tests can assert.
- Mixed artifact states remain visible on the same screen without aggregation.
- Artifact provenance is part of the display contract, not optional metadata.
- The browser surface remains usable with keyboard navigation and narrow viewports
  without a framework or remote asset supply chain.
- Command execution, repository mutation, egress, hosted identity, ingestion, sync,
  billing, and all Control Plane concerns remain outside the Cockpit.
- The optional Cockpit does not alter existing CLI, MCP, workflow, or wire-protocol
  behavior for repositories that do not start it.

## Rejected alternatives

**Compute summaries when artifacts are missing.** Rejected because a presentation
fallback would become a second authority engine and could make absence look passing.

**Execute the displayed next command.** Rejected because execution changes the
Cockpit from inspection into workflow control and would make a compromised browser
session a command runner.

**Use a framework, CDN, hosted font, or telemetry service.** Rejected because the
surface is small, local, and no-egress. Those dependencies add supply-chain and
network behavior without providing a required capability.

**Read `.visp-memory/` directly.** Rejected because Phase 9 selects the three canonical
`.visp/memory/` artifacts for this view; direct access would cross the separately
governed Memory store and publication boundary.
