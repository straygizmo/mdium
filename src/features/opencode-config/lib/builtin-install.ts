/**
 * Version markers let mdium update the builtin tool/skill files it installed
 * without clobbering files the user wrote or edited by hand (no marker).
 */
export const TOOL_VERSION_RE = /mdium-tool-version:\s*(\d+)/;
export const SKILL_VERSION_RE = /mdium-skill-version:\s*(\d+)/;

export function builtinVersion(content: string, re: RegExp): string | null {
  return content.match(re)?.[1] ?? null;
}

export function shouldWriteBuiltinFile(
  existing: string | null,
  wanted: string,
  re: RegExp,
): boolean {
  if (existing === null) return true;
  const current = builtinVersion(existing, re);
  if (current === null) return false;
  return current !== wanted;
}

/** SKILL.md with frontmatter (name, optional description, optional version). */
export function buildSkillMd(
  name: string,
  description: string,
  body: string,
  version?: number,
): string {
  const lines = ["---", `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  if (version !== undefined) lines.push(`mdium-skill-version: ${version}`);
  lines.push("---", "");
  if (body) lines.push(body);
  return lines.join("\n");
}
