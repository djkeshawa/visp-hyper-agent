# Contributing

Bug reports and pull requests are welcome.

## What is most useful

This project's whole claim is that it stops unproven work reaching review. So
the most valuable report is one showing it failed at that:

- **It allowed something it should have blocked.** The most serious class of
  defect, because it is a failure of the central claim.
- **It blocked something correct and in scope.** Over-blocking is a real defect,
  not an inconvenience to be tuned away.
- **It gave confident guidance from state it could not read**, or reported a
  problem without saying what to do about it.

Documentation that overstates what this tool has been shown to do is also a bug.
No productivity or correctness claim has been substantiated, so if you find one
in the docs, report it.

## Reporting a bug

Include:

1. The exact command and arguments.
2. What you expected, and what happened.
3. The relevant contents of `.visp/`, redacted as needed — those artifacts
   describe your code.
4. `visp-hyper --version`, your Node version, and your operating system.

## Security issues

Do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests

```bash
pnpm install
pnpm build
pnpm test
```

Node 22+ and pnpm 11+.

Before opening a PR:

- `pnpm check` passes, which runs typecheck, build, and the test suite.
- New behaviour has a test. A test written to match the code you just wrote is
  weaker evidence than one written from the requirement — this project cares
  about that distinction more than most.
- The change is narrow. Unrelated cleanups in the same PR make review harder.

### Three constraints that will not be relaxed

A PR crossing any of these will be declined regardless of quality:

1. **Visp Hyper never calls an LLM.** Your coding tool does the thinking; Hyper
   decides what it may work on and records what happened.
2. **Kit decides; Hyper coordinates.** A Hyper checkpoint may never grant
   permission Kit withheld. Hyper must not become a second authority engine.
   The repository carries `docs/adr/0001-kit-is-authoritative.md` and the
   semantics inventory it references; both are in the source tree rather than
   the package, because they are contributor material.
3. **A user prompt is raw intent only.** Nothing typed into a prompt may widen a
   task's scope, skip a gate, or approve a change.

See [docs/development.md](docs/development.md) for the build, and
[docs/commands.md](docs/commands.md) for the command surface.

## Honest limitations

Before reporting something as a bug, it may be a known limit:

- **Conformance is partial.** Some areas are proven and some are not.
- **Kit and Hyper are compatible in tested pairs**, pinned to exact commits. Do
  not assume any two versions work together.
- **Durable shared memory is not available yet.** File-based memory is the
  default; the legacy HTTP mode exists only for private migrations.
- **`inconclusive` is a deliberate verdict.** It means the evidence did not
  establish the claim, not that the claim failed.
