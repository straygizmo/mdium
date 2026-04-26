const port = process.env.MDIUM_VBA_PORT;
const token = process.env.MDIUM_VBA_TOKEN;

if (!port || !token) {
  console.error(
    "mdium-vba MCP server: missing required env vars MDIUM_VBA_PORT / MDIUM_VBA_TOKEN"
  );
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;
const authHeader = `Bearer ${token}`;

/**
 * Get the currently active .xlsm/.xlam tab in MDium.
 * Returns null if no such tab is active.
 */
export async function getActiveXlsm(): Promise<string | null> {
  const response = await fetch(`${base}/active-xlsm`, {
    headers: { Authorization: authHeader },
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve active xlsm (HTTP ${response.status})`);
  }
  const json = (await response.json()) as { path: string | null };
  return json.path;
}

interface RequestBody {
  xlsm_path: string;
  macros_dir?: string;
}

export async function callBridge(
  route: "/vba/list" | "/vba/extract" | "/vba/inject",
  body: RequestBody
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(base + route, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = { error: "invalid_response" };
  }
  return { status: response.status, json };
}
