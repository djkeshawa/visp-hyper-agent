/**
 * Has `visp work` ever written a handoff in this project?
 *
 * Two checks need the answer and must not disagree about it. Freshness and the
 * active Kit read contract are both claims about an artifact an agent was
 * handed; where no handoff exists there is no such artifact, and reporting
 * "no context manifest" describes the absence of work rather than a hole in
 * it — the distinction `checkHyperInitialized` already draws between an empty
 * store and a store that lost its sessions.
 *
 * It matters because both findings are verdict-bearing (see `./verdict.ts`).
 * Without this, every correctly set-up project that had not yet run `visp work`
 * would report INCONCLUSIVE, and a verdict that is never green carries no more
 * information than one that is always green.
 */

import { fileExists, vispPath } from "../../../core/fs-utils.js";

export async function activeHandoffExists(projectPath: string): Promise<boolean> {
  const [manifest, session] = await Promise.all([
    fileExists(vispPath(projectPath, "hyper", "current", "context-manifest.json")),
    fileExists(vispPath(projectPath, "hyper", "current", "session.md"))
  ]);
  return manifest || session;
}
