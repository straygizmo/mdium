import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES_DIR = join(__dirname, "..", "locales");

/** Flattens nested translation objects into dotted key paths. */
function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function readKeys(lang: string, file: string): string[] {
  const json: unknown = JSON.parse(readFileSync(join(LOCALES_DIR, lang, file), "utf8"));
  return flattenKeys(json).sort();
}

const jaFiles = readdirSync(join(LOCALES_DIR, "ja")).filter((f) => f.endsWith(".json")).sort();
const enFiles = readdirSync(join(LOCALES_DIR, "en")).filter((f) => f.endsWith(".json")).sort();

describe("locale parity", () => {
  it("ja and en have the same namespace files", () => {
    expect(enFiles).toEqual(jaFiles);
    expect(jaFiles).toContain("workflow.json");
  });

  it.each(jaFiles)("%s has identical key sets in ja and en", (file) => {
    const ja = readKeys("ja", file);
    const en = readKeys("en", file);
    const missingInEn = ja.filter((k) => !en.includes(k));
    const missingInJa = en.filter((k) => !ja.includes(k));
    expect({ missingInEn, missingInJa }).toEqual({ missingInEn: [], missingInJa: [] });
  });
});
