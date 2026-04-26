import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import { callBridge, getActiveXlsm } from "./http-client.js";

function deriveMacrosDir(xlsmPath: string): string {
  const parsed = path.parse(xlsmPath);
  return path.join(parsed.dir, `${parsed.name}_macros`);
}

function toolText(obj: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

const server = new McpServer({
  name: "mdium-vba",
  version: "1.0.0",
});

async function resolveAndCall(
  route: "/vba/list" | "/vba/extract" | "/vba/inject",
  includeMacrosDir: boolean
) {
  let xlsm: string | null;
  try {
    xlsm = await getActiveXlsm();
  } catch (e) {
    return toolText({
      error: "bridge_unavailable",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!xlsm) {
    return toolText({
      error: "no_active_xlsm",
      message: "No active .xlsm/.xlam tab in MDium. Open one first.",
    });
  }
  const body: { xlsm_path: string; macros_dir?: string } = { xlsm_path: xlsm };
  if (includeMacrosDir) body.macros_dir = deriveMacrosDir(xlsm);

  let result = await callBridge(route, body);

  // Retry once on active_tab_changed race condition
  if (
    result.status === 409 &&
    typeof result.json === "object" &&
    result.json !== null &&
    (result.json as { error?: string }).error === "active_tab_changed"
  ) {
    const fresh = await getActiveXlsm();
    if (fresh) {
      const retryBody: { xlsm_path: string; macros_dir?: string } = {
        xlsm_path: fresh,
      };
      if (includeMacrosDir) retryBody.macros_dir = deriveMacrosDir(fresh);
      result = await callBridge(route, retryBody);
    }
  }

  return toolText(result.json);
}

server.tool(
  "list_vba_modules",
  "List VBA modules in the currently active .xlsm/.xlam tab in MDium. Returns macros directory path, whether it has been extracted, and module list.",
  {},
  async () => resolveAndCall("/vba/list", false)
);

server.tool(
  "extract_vba_modules",
  "Extract VBA modules from the currently active .xlsm/.xlam tab into {stem}_macros/. Overwrites existing files. Returns the macros directory and module list.",
  {},
  async () => resolveAndCall("/vba/extract", false)
);

server.tool(
  "import_vba_macros",
  "Import modified .bas/.cls files from {stem}_macros/ back into the currently active .xlsm/.xlam tab. Refuses if the module set differs (no adding or removing modules is supported). Returns updatedModules and backupPath on success.",
  {},
  async () => resolveAndCall("/vba/inject", true)
);

const transport = new StdioServerTransport();
await server.connect(transport);
