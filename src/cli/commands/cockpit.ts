import { Command } from "commander";

import { startCockpitServer } from "../../cockpit/server.js";
import { resolveProjectPath } from "./shared.js";

export function cockpitCommand(): Command {
  return new Command("cockpit")
    .description("Serve the read-only local Cockpit for this repository.")
    .action(async function (this: Command) {
      const server = await startCockpitServer({ projectPath: resolveProjectPath(this) });
      console.log(`Cockpit: ${server.url}`);
      console.log("Press Ctrl-C to stop the local read-only server.");

      const stop = waitForTerminationSignal();
      try {
        await stop.done;
      } finally {
        stop.dispose();
        await server.close();
      }
    });
}

function waitForTerminationSignal(): Readonly<{
  done: Promise<void>;
  dispose: () => void;
}> {
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  const onSignal = (): void => resolveDone();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const dispose = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  return Object.freeze({ done, dispose });
}
