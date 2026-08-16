/**
 * Which command actually moves an uninitialised project forward.
 *
 * Doctor used to name `visp setup` unconditionally. On a machine without the
 * Visp Dev machine-scope adapter that is a step doctor can know will fail, and
 * naming it produced a closed loop: doctor said run setup, setup said install
 * the adapter, and the user who had already installed it had nowhere to go.
 * The project-scope route was reachable the whole time — no verb mentioned it.
 */

import { machineScopeAvailable } from "../../machine/machine-scope.js";

/** What to recommend when `visp setup` has a machine scope to run. */
export const MACHINE_SCOPE_ROUTE = "Run `visp setup`.";

/**
 * What to recommend when it does not. `visp-kit init .` sets the project up
 * without any machine-scope step, which is the whole of what a blocked user
 * needs next.
 */
export const PROJECT_SCOPE_ROUTE =
  "Run `visp-kit init .` to set this project up (install it first if needed: " +
  "`npm install -g visp-kit`). `visp setup` cannot help here: " +
  "it needs the Visp Dev machine-scope adapter, and nothing on this machine provides it.";

export async function setupRoute(): Promise<string> {
  return (await machineScopeAvailable()) ? MACHINE_SCOPE_ROUTE : PROJECT_SCOPE_ROUTE;
}
