// The suite must not depend on what happens to be installed on the machine.
//
// Hyper spawns Kit by name: `resolveKitBinary` probes PATH for `visp-kit` and
// falls back to `visp` (src/kit/kit-binary-resolver.ts). That is correct in
// production and ruinous in a test run, because a globally installed Kit is
// then spawned against the temp fixture projects the tests build.
//
// Measured, on this repository, with the four products installed globally the
// way a user installs them:
//
//     with a globally installed visp-kit   187 failing
//     with it removed from PATH           1156 passing
//
// So the suite passed only while the developer had NOT installed the product it
// drives. Dogfooding broke the tests — which is precisely backwards, and it is
// the recurring defect of this codebase in a new place: those tests were
// passing because a binary was absent, not because the code was right. They
// would have gone green against a completely broken Kit.
//
// WHY NOT THE OBVIOUS FIXES
//
// Setting VISP_KIT_BINARY here would win over PATH and break the sixteen test
// files that legitimately stub Kit by putting a shim on PATH.
//
// Dropping the offending PATH directory wholesale would also remove `node`,
// `npm` and `visp-memory` — and tests/memory-contract-integration.test.ts
// deliberately requires the real visp-memory and FAILS rather than skips when
// it is missing, which is the right call for a contract test.
//
// So each directory that provides a Visp *Kit or coordinator* binary is
// replaced by a twin containing symlinks to everything it held except those
// binaries. Everything else on PATH survives untouched; only the ambient Kit
// disappears. A test that wants a Kit still prepends its own shim, exactly as
// before.
//
// Building and caching those twins is `./path-twin-farm.ts`, which is where the
// one hard question lives: whether a twin already on disk may be believed.

import { sanitisePath } from "./path-twin-farm.js";

process.env.PATH = sanitisePath({ path: process.env.PATH ?? "" });
