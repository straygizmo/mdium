import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import { RulesEditor } from "../shared/RulesEditor";
import type { Scope } from "../shared/ScopeToggle";
import { joinPath } from "../../lib/config-paths";

/** Claude Code reads ~/.claude/CLAUDE.md globally and CLAUDE.md at the project root. */
async function rulesPath(scope: Scope, folder: string): Promise<string> {
  if (scope === "project") return joinPath(folder, "CLAUDE.md");
  const home = await invoke<string>("get_home_dir");
  return joinPath(home, ".claude", "CLAUDE.md");
}

export function RulesSection() {
  const folder = useTabStore((s) => s.activeFolderPath)!;
  return <RulesEditor folder={folder} ns="claude-config" rulesPath={rulesPath} />;
}
