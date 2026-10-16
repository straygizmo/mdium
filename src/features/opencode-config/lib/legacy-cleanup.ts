import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { LEGACY_VBA_MCP_NAME } from "./builtin-install";

/**
 * Delete the `mdium-vba` MCP entry that older MDium versions wrote into the
 * global opencode config. Other entries are kept. Returns true when an entry
 * was removed.
 */
export async function removeLegacyVbaMcpServer(): Promise<boolean> {
  const store = useOpencodeConfigStore.getState();
  await store.loadConfig();
  if (!useOpencodeConfigStore.getState().config.mcp?.[LEGACY_VBA_MCP_NAME]) return false;
  await store.deleteMcpServer(LEGACY_VBA_MCP_NAME);
  return true;
}
