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

/**
 * Name of the removed `mdium-vba` MCP server. The marker-less builtin skill
 * shipped before version markers referenced it, which tells that old builtin
 * apart from a skill the user wrote.
 */
export const LEGACY_VBA_MCP_NAME = "mdium-vba";

/**
 * Like shouldWriteBuiltinFile for SKILL.md, but also upgrades the old
 * marker-less builtin skill (recognized by its `mdium-vba` reference).
 */
export function shouldWriteBuiltinSkill(existing: string | null, wanted: string): boolean {
  if (
    existing !== null &&
    builtinVersion(existing, SKILL_VERSION_RE) === null &&
    existing.includes(LEGACY_VBA_MCP_NAME)
  ) {
    return true;
  }
  return shouldWriteBuiltinFile(existing, wanted, SKILL_VERSION_RE);
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
