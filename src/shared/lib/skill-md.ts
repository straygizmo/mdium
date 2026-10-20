/** SKILL.md with a `name` / `description` frontmatter (the fields Codex and Copilot read) followed by the body. */
export function buildSkillMarkdown(name: string, description: string, body: string): string {
  const lines = ["---", `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  lines.push("---");
  const trimmed = body.trim();
  if (trimmed) lines.push("", trimmed);
  return lines.join("\n") + "\n";
}
