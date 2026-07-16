import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [hyperDist, project, noKitPath] = process.argv.slice(2);
assert.ok(hyperDist && project && noKitPath, "expected Hyper, project, and no-Kit paths");
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
);
childEnv.PATH = noKitPath;
const child = spawn(
  process.execPath,
  [hyperDist, "--project", project, "serve", "--mcp"],
  { env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
);
const exitPromise = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
const responses = new Map();
const stderr = [];
let buffer = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(message.id, message);
    }
  }
});
const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({
  jsonrpc: "2.0",
  id: 100,
  method: "tools/call",
  params: { name: "hyper_report", arguments: {} },
});
send({
  jsonrpc: "2.0",
  id: 101,
  method: "tools/call",
  params: { name: "hyper_next", arguments: {} },
});
const deadline = Date.now() + 20_000;
while ((!responses.has(100) || !responses.has(101)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
let validationError;
let evidence;
try {
  assert.ok(
    responses.has(100) && responses.has(101),
    "missing MCP responses; stderr=" + stderr.join(""),
  );
  const report = responses.get(100).result;
  const next = responses.get(101).result;

  assert.equal(report.isError, false);
  assert.equal(report.structuredContent.isError, false);
  assert.equal(report.structuredContent.status, "OK");
  assert.match(report.structuredContent.text, /BEGIN_VISP_HYPER_REPORT/u);
  assert.deepEqual(report.content, [{ type: "text", text: report.structuredContent.text }]);
  assert.deepEqual(report.structuredContent.frames, [
    { name: "VISP_HYPER_REPORT", boundary: "begin" },
    { name: "VISP_HYPER_REPORT", boundary: "end" },
  ]);

  assert.equal(next.isError, false);
  assert.equal(next.structuredContent.isError, false);
  assert.equal(next.structuredContent.status, "INCONCLUSIVE");
  assert.notEqual(next.structuredContent.status, "OK");
  assert.match(next.structuredContent.text, /BEGIN_VISP_NEXT_ACTION/u);
  assert.deepEqual(next.content, [{ type: "text", text: next.structuredContent.text }]);
  assert.deepEqual(next.structuredContent.frames, [
    { name: "VISP_NEXT_ACTION", boundary: "begin" },
    { name: "VISP_NEXT_ACTION", boundary: "end" },
  ]);
  evidence = {
    reportStatus: report.structuredContent.status,
    unknownSuccessfulNextStatus: next.structuredContent.status,
    transportErrors: [report.isError, next.isError],
  };
} catch (error) {
  validationError = error;
}

child.stdin.end();
const exitCode = await exitPromise;
if (validationError) throw validationError;
assert.equal(exitCode, 0, "MCP server exited nonzero; stderr=" + stderr.join(""));
console.log(JSON.stringify({ ...evidence, exitCode }, null, 2));
