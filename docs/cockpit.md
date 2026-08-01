# Cockpit

The Cockpit is Hyper's local, read-only presentation surface over one repository's
`.visp/` artifacts. It renders artifact state; it does not decide workflow
permission, scope, evidence sufficiency, review outcome, completion, or pull-request
readiness. Those facts appear only when a source artifact supplies them, and the
source path remains visible beside every rendered value.

## Screen inventory

The navigation order and identifiers are part of the versioned interface:

| Order | Label | ID |
|---:|---|---|
| 1 | Now | `now` |
| 2 | Feature | `feature` |
| 3 | Scope | `scope` |
| 4 | Assurance | `assurance` |
| 5 | Review | `review` |
| 6 | Runs | `runs` |
| 7 | Memory | `memory` |
| 8 | Health | `health` |
| 9 | Reference | `reference` |

The command palette is an interaction across these screens, not a tenth screen.
Phase 9 exposes this surface as `visp-hyper cockpit`. The unified
`visp cockpit` spelling belongs to planned Phase 10 and does not become active until
that phase is explicitly activated and implemented.

## State contract

`src/cockpit/contracts.ts` defines Cockpit API version `1.0`. `screens` is a map
containing exactly the nine screen IDs. A screen has a stable ID/label and a nonempty
`artifacts` array; it has no aggregate state. Every artifact view has its own stable
ID/label and is independently discriminated:

- `present` requires a primary `sourcePath` and at least one artifact value. Every
  value carries its own `sourcePath`.
- `uninitialized`, `missing`, and `unavailable` require a nonempty `reason` and
  `expectedPath`; a source path may also be supplied when one exists.
- `stale` and `corrupt` require a nonempty `reason`, `expectedPath`, and
  `sourcePath` because an on-disk artifact caused the state.

Artifact values are presentation-neutral scalar quotes. The contract deliberately
has no authority, permission, readiness, or computed verdict fields. A valid
`present` artifact cannot have an empty value list. The browser renders every
artifact independently, including mixed present and degraded states, and computes no
"worst" screen state or aggregate badge. A malformed view becomes its own visible
contract failure instead of hiding healthy sibling artifacts or making a partial
failure look wholly present.

All provenance uses the runtime-branded `CockpitArtifactPath`: a repository-relative
POSIX path below `.visp/`. Absolute paths, backslashes, empty/dot segments, control
characters, query or fragment delimiters, and percent-encoded-looking paths are
rejected. Memory applies the narrower three-path allowlist below.

Freshness is supplied by the artifact reader only when a caller provides an explicit
freshness boundary. The Cockpit defines no default freshness window, no universal
stale TTL, and no wall-clock rule that turns a valid artifact stale by itself.

The Review screen binds a current-decision pointer to the active feature and task,
its canonical history path, and the history record's feature, task, hash, and
timestamp identities before quoting the stored decision. A mismatch is unavailable;
this structural check does not calculate decision freshness or a workflow verdict.

## Runs pagination and event tails

Runs and run-event pages are API-versioned and generic over values already validated
by Kit's artifact reader. Hyper does not duplicate Kit's run or event schema. Every
page cites its artifact `sourcePath`.

The Runs page uses record offsets and returns `nextOffset` as either the next record
offset or explicit `null` at the end. The event page uses byte offsets and always
returns its next byte offset, a `rotated` flag, and an opaque `generation`. A client
resubmits both offset and generation. The generation binds the file identity, first
record, and a bounded byte window immediately before that cursor; it advances with
the cursor but remains valid when bytes are only appended after it. When the supplied
generation no longer matches (including truncation, same-inode regrowth near the
cursor, or rotation), the host restarts from byte zero, returns `rotated: true`,
supplies the new generation, and the client discards its old cursor. Complete JSONL
records advance the byte cursor; a partial trailing record is withheld until complete.
If a first record is longer than the 64 KiB generation window, the host hashes its
bounded prefix rather than treating the record as invalid. The generation window is
not a Kit schema limit. If the run index shrinks below a visited page offset, the host
returns a terminal empty page and the client returns to the nearest still-valid page.

The bounded error envelope exposes only a fixed error code, a message capped at 512
characters, and optional degraded artifact state/path provenance. It carries no
stack, filesystem detail, replacement verdict, or duplicate validation schema. The
static shell does not fabricate run records, totals, outcomes, or verdicts.

Each event-tail response reads at most 1 MiB from disk. A complete valid record beyond
that transport window is reported as unavailable, not corrupt. A long-lived browser
tab also retains at most 256 event records and 2 MiB of UTF-8 serialized event bytes.
When that display budget is exceeded, the oldest or oversized records are omitted
with a visible count and the source path remains shown; the artifact and byte cursor
are not modified.
Complete JSONL records must also be strict UTF-8. Invalid byte sequences are reported
as corrupt rather than replacement-decoded into a different schema-valid event.

## Commands

The palette always offers navigation. A command appears only when the state response
contains a nonempty command string and its artifact `sourcePath`. Activating it uses
the browser clipboard and performs no execution. If the command artifact is absent,
malformed, or lacks provenance, the palette shows an explicit unavailable panel.
There is no command literal or command fallback in the static assets.

## Memory boundary

Memory is labelled **cited project context · non-authoritative**. Phase 9 chooses only
the canonical `.visp/memory/constitution.md`, `.visp/memory/patterns.md`, and
`.visp/memory/project-summary.md` artifact view. It does not read or imply a contract
with `.visp-memory/`. Memory context cannot grant permission, change scope, certify
evidence, or alter any Kit result.

## Browser and transport boundary

`src/cockpit/ui.ts` exports the document, stylesheet, client script, restrictive CSP,
and a static-asset manifest. The surface uses no framework, remote asset, web font,
telemetry, or dependency. All DOM content is assigned as text rather than parsed as
artifact HTML.

The client:

1. reads the per-session token from the initial query or fragment into a closure;
2. immediately removes that token from the visible address and current history entry;
3. sends it as a bearer credential on same-origin state requests;
4. uses it for the same-origin EventSource connection, whose browser API cannot set an
   authorization header; and
5. refetches state after path-only invalidation events; and
6. refetches state when SSE reconnects before marking the connection live, closing
   the event-gap race between disconnect and reconnection.

The badge gives unavailable, reconnecting, and connecting transport states precedence
over an in-flight state response. It reports live only after a successful state fetch
associated with the currently open EventSource epoch.

The token is not persisted in browser storage. The UI sends only `GET` requests and
contains no repository mutation path. Because EventSource authentication uses the
query string, the document declares `no-referrer`, its asset manifest carries the
matching `Referrer-Policy`, and the host must emit `Referrer-Policy: no-referrer` on
the document response. The host remains responsible for exact `127.0.0.1` binding,
Host-header validation, token enforcement, response headers, watching, pagination,
and byte-offset tails.

The recursive watcher rejects a symbolic `.visp` root and supervises both its project
root and artifact handles. Initial arming failures stop startup. A runtime watcher
failure closes stale handles, emits only a root `.visp` invalidation, and retries
through one delayed timer; repeated failures therefore drive bounded state refreshes
instead of leaving an apparently live tab indefinitely stale. Run-event paths reject
every final or intermediate symbolic link below the canonical project root, including
links whose targets remain inside the repository, so displayed provenance is the
physical canonical artifact path rather than an alias.
Run tails open descriptors with non-blocking and no-follow flags where supported and
require regular-file descriptor metadata before reading. A FIFO or other special file
is therefore unavailable rather than a blocking or corrupt artifact.

At startup the host canonicalizes the project root and records its device/inode. State,
run-list, and run-tail requests check that identity before and after their asynchronous
filesystem read; replacing the canonical directory entry fails closed, while
retargeting the caller's original symlink cannot move the running session. This is not
an atomic filesystem snapshot: a hostile replace-and-restore entirely between those
checks remains a documented ABA limitation of the portable path-based implementation.

The static assets are designed for this CSP:

```text
default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'; form-action 'none'; media-src 'none'; worker-src 'none';
manifest-src 'none'
```

It requires neither `unsafe-inline` nor `unsafe-eval`.

## Accessibility and responsive behavior

The document provides header, navigation, main, section, and dialog landmarks; a
skip link; visible focus; live status regions; and source/reason text that does not
depend on color. Arrow keys, Home, and End move through screen navigation. Control-K
or Command-K opens the palette, whose results also support arrow-key movement. On
narrow viewports the sidebar becomes a horizontally scrollable screen list while the
content remains in document order.

## Security invariants

- The Cockpit quotes artifacts and never fills a missing fact with an inferred pass.
- A degraded state remains named, explained, and attributed to an expected/source path.
- The browser executes no command and writes no repository file.
- The client has no outbound URL or telemetry path; all transport is same-origin.
- Static assets require no inline script, inline style, dynamic evaluation, or CDN.
- Hosted identity, synchronization, ingestion, billing, and Control Plane code remain
  outside this surface.

See `docs/adr/0004-cockpit-read-only-local-surface.md` for the accepted placement and
boundary decision.
