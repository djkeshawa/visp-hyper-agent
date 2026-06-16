import { Command, Option } from "commander";
import { runStdioServer } from "../../mcp/mcp-server.js";
import { createToolContext } from "../../mcp/tool-bridge.js";
import { resolveProjectPath } from "./shared.js";

export function serveCommand(): Command {
  return new Command("serve")
    .description("Serve the hyper workflow over MCP (newline-delimited JSON-RPC 2.0 on stdio).")
    .addOption(new Option("--mcp", "Use the MCP stdio transport.").makeOptionMandatory())
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const ctx = createToolContext(projectPath);
      await runStdioServer(ctx);
    });
}
