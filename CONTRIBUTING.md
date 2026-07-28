# Contributing to Visp Hyper Agent

Thank you for your interest. Please read this before opening an issue or a pull
request — it will save you time.

## Current status: not open for code contributions

This repository is published as a package but developed privately. **Pull
requests cannot currently be accepted**, because the source repository is not
public and there is no contributor licence agreement in place.

This is stated plainly rather than left implicit, so nobody writes a patch that
has nowhere to go.

## What is welcome right now

**Bug reports and correctness findings.** They are the most valuable thing you
can send, and this project cares about them more than most:

- A case where Visp **allowed** something it should have blocked. This is the
  most serious class of defect. Hyper coordinates enforcement that Kit decides,
  and a gap in that is a failure of the product's central claim.
- A case where Visp **blocked** something correct and in scope. Over-blocking is
  a real defect, not an inconvenience to be tuned away.
- A case where Visp gave confident guidance derived from state it could not
  read, or reported a problem without saying what to do about it.

**Documentation that is wrong**, including anything that overstates what this
tool has been shown to do.

## Reporting a security issue

Do **not** open a public issue. Follow `SECURITY.md`.

## What makes a good report

The workflow is evidence-driven, so a report with evidence is far easier to act
on:

1. What you ran, exactly — the command and its arguments.
2. What you expected, and what happened.
3. The relevant contents of `.visp/` if you can share them, and the
   WorkflowAction your host received. Redact anything private first; these
   artifacts describe your code.
4. Versions: `visp-hyper --version`, your Node version, and your operating system.

A report that says "the gate was wrong" without the artifacts is hard to act on.
A report with the artifacts is usually reproducible immediately.

## Honest limitations

Before reporting something as a bug, it may already be a known limit:

- **Conformance is partial.** Some areas are proven and some are not; the
  published conformance report says which.
- **Compatibility is proven pair by pair**, pinned to exact commits and package
  hashes. It is not a version-range support window.
- **No performance or review-efficiency claim has been substantiated.** If you
  see such a claim anywhere in the documentation, that is a documentation bug
  and reporting it is welcome.

## If this opens up later

Should the source repository become public, this file will be replaced with real
contribution instructions covering the development setup, the test suite, and
the review process. Until then, the honest answer is the one above.
