import { runCliCommand } from "./cli/index.js";

const result = await runCliCommand(process.argv);
if (result.exitCode !== 0) {
  process.exitCode = result.exitCode;
}
