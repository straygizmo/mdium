// Entry point of the bundled mdium-docs MCP server
// (resources/mcp-servers/mdium-docs/dist/index.js, built by
// scripts/build-doc-converter.mjs). Also usable as a CLI:
//   node index.js convert <input> <output.md>
import { createInterface } from "node:readline";
import { convertFileToMarkdown } from "./convert-file";
import { handleMcpLine } from "./mcp-server";
import { routeConsoleToStderr } from "./node-env";

// stdout carries the protocol; anything a library logs goes to stderr.
routeConsoleToStderr();

async function runCli(args: string[]): Promise<void> {
  const [input, output] = args;
  if (!input || !output) {
    process.stderr.write("usage: node index.js convert <input> <output.md>\n");
    process.exit(2);
  }
  try {
    const result = await convertFileToMarkdown(input, output);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function runServer(): void {
  const inFlight = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const handled: Promise<void> = handleMcpLine(line)
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .finally(() => inFlight.delete(handled));
    inFlight.add(handled);
  });
  // Answer every request already received before exiting on stdin EOF.
  rl.on("close", () => {
    void Promise.allSettled([...inFlight]).then(() => process.exit(0));
  });
}

const [command, ...rest] = process.argv.slice(2);
if (command === "convert") {
  void runCli(rest);
} else {
  runServer();
}
