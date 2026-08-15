/**
 * The Cockpit client program, assembled from its fragments.
 *
 * The order below is the program's own order and is not interchangeable.
 * `COCKPIT_CLIENT_RUNTIME` must come first: it opens with "use strict" and
 * declares the top-level `const` bindings every later fragment reads, and a
 * `const` is in its temporal dead zone until then. `COCKPIT_CLIENT_PALETTE`
 * must come last: it ends with the bootstrap calls that start the program.
 * The fragments in between hold only function declarations, which the module
 * hoists, so they may be read in any order but are kept in reading order.
 *
 * Joining with a newline reproduces the file boundaries exactly, because each
 * fragment after the first opens on the blank line that separated it.
 */

import { COCKPIT_CLIENT_ARTIFACTS } from "./client-artifacts.js";
import { COCKPIT_CLIENT_PALETTE } from "./client-palette.js";
import { COCKPIT_CLIENT_RUNS } from "./client-runs.js";
import { COCKPIT_CLIENT_RUNTIME } from "./client-runtime.js";
import { COCKPIT_CLIENT_SCREENS } from "./client-screens.js";

export const COCKPIT_JAVASCRIPT = [
  COCKPIT_CLIENT_RUNTIME,
  COCKPIT_CLIENT_ARTIFACTS,
  COCKPIT_CLIENT_RUNS,
  COCKPIT_CLIENT_SCREENS,
  COCKPIT_CLIENT_PALETTE
].join("\n").concat("\n");
