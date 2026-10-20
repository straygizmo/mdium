import { invoke } from "@tauri-apps/api/core";
import { RulesEditor } from "@/features/claude-config/components/shared/RulesEditor";
import type { Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { joinPath } from "@/features/claude-config/lib/config-paths";

/** Codex reads ~/.codex/AGENTS.md globally and AGENTS.md at the project root. */
async function rulesPath(scope: Scope, folder: string): Promise<string> {
  if (scope === "project") return joinPath(folder, "AGENTS.md");
  const home = await invoke<string>("get_home_dir");
  return joinPath(home, ".codex", "AGENTS.md");
}

interface RulesSectionProps {
  folder: string;
}

export function RulesSection({ folder }: RulesSectionProps) {
  return <RulesEditor folder={folder} ns="codex-config" rulesPath={rulesPath} />;
}
