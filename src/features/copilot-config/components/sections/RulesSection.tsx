import { invoke } from "@tauri-apps/api/core";
import { RulesEditor } from "@/features/claude-config/components/shared/RulesEditor";
import type { Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { joinPath } from "@/features/claude-config/lib/config-paths";

/** Copilot CLI reads ~/.copilot/copilot-instructions.md personally and .github/copilot-instructions.md in the repository. */
async function rulesPath(scope: Scope, folder: string): Promise<string> {
  if (scope === "project") return joinPath(folder, ".github", "copilot-instructions.md");
  const home = await invoke<string>("get_home_dir");
  return joinPath(home, ".copilot", "copilot-instructions.md");
}

interface RulesSectionProps {
  folder: string;
}

export function RulesSection({ folder }: RulesSectionProps) {
  return <RulesEditor folder={folder} ns="copilot-config" rulesPath={rulesPath} />;
}
