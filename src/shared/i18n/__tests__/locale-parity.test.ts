// @vitest-environment happy-dom
// happy-dom: importing the i18n setup reads localStorage.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "@/shared/i18n";

const LOCALES_DIR = join(__dirname, "..", "locales");

/** Flattens nested translation objects into dotted key paths with their leaf values. */
function flatten(value: unknown, prefix = ""): [string, unknown][] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [[prefix, value]];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function readJson(lang: string, file: string): unknown {
  return JSON.parse(readFileSync(join(LOCALES_DIR, lang, file), "utf8"));
}

function readLeaves(lang: string, file: string): Map<string, unknown> {
  return new Map(flatten(readJson(lang, file)));
}

/** Sorted `{{name}}` interpolation placeholders of a leaf value. */
function placeholders(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)].map((m) => m[1]).sort();
}

const jaFiles = readdirSync(join(LOCALES_DIR, "ja")).filter((f) => f.endsWith(".json")).sort();
const enFiles = readdirSync(join(LOCALES_DIR, "en")).filter((f) => f.endsWith(".json")).sort();

describe("locale parity", () => {
  it("ja and en have the same namespace files", () => {
    expect(enFiles).toEqual(jaFiles);
    expect(jaFiles).toContain("workflow.json");
  });

  it.each(jaFiles)("%s has identical key sets in ja and en", (file) => {
    const ja = [...readLeaves("ja", file).keys()];
    const en = [...readLeaves("en", file).keys()];
    const missingInEn = ja.filter((k) => !en.includes(k));
    const missingInJa = en.filter((k) => !ja.includes(k));
    expect({ missingInEn, missingInJa }).toEqual({ missingInEn: [], missingInJa: [] });
  });

  it.each(jaFiles)("%s uses the same placeholders in ja and en", (file) => {
    const ja = readLeaves("ja", file);
    const en = readLeaves("en", file);
    const mismatched = [...ja.keys()]
      .filter((k) => en.has(k))
      .filter((k) => placeholders(ja.get(k)).join(",") !== placeholders(en.get(k)).join(","));
    expect(mismatched).toEqual([]);
  });

  it.each(jaFiles)("%s is registered in the i18n resources for ja and en", (file) => {
    for (const lang of ["ja", "en"]) {
      const bundles = i18n.options.resources?.[lang] ?? {};
      const json = readJson(lang, file);
      const registered = Object.values(bundles).some(
        (bundle) => JSON.stringify(bundle) === JSON.stringify(json),
      );
      expect(registered, `${lang}/${file}`).toBe(true);
    }
  });
});
