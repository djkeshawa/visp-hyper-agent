# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature for this repository. If
that feature is unavailable, contact the repository owner through their
verified GitHub profile and request a private reporting channel. Do not include
exploit details or sensitive project data in public discussions.

Include:

- the affected commit or version;
- the impacted command, contract, or compatibility path;
- reproduction steps;
- expected and observed behavior; and
- any known mitigation.

You should receive an acknowledgement within seven days. Disclosure timing
will be coordinated after the issue is reproduced and a remediation plan is
available.

## Scope

Security-sensitive areas include:

- installed-binary confinement and source-fallback prevention;
- package provenance and duplicate-pack validation;
- report integrity and coordinated-tamper detection;
- path traversal and temporary-root ownership;
- lifecycle-script suppression; and
- strict protocol fail-closed behavior.

The repository currently publishes compatibility evidence, not hosted
services. Reports apply only to the exact commits and environments they name.
