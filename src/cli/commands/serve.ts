import { Command, Option } from "commander";
import { runStdioServer } from "../../mcp/mcp-server.js";
import { createToolContext } from "../../mcp/tool-bridge.js";
import { resolveProjectPath } from "./shared.js";

export function serveCommand(): Command {
  return new Command("serve")
    .description("Serve the hyper workflow over MCP (newline-delimited JSON-RPC 2.0 on stdio).")
    .addOption(new Option("--mcp", "Use the MCP stdio transport (required)."))
    .action(async function (this: Command, options: { mcp?: boolean }) {
      if (!options.mcp) {
        console.error("only --mcp transport is available.");
        process.exitCode = 1;
        return;
      }
      const projectPath = resolveProjectPath(this);
      const ctx = createToolContext(projectPath);
      await runStdioServer(ctx);
    });
}
