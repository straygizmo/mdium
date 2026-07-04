# 置換（Replacement / Masking）機能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 機密文字列をLLM送信前にマスク（前→後）し、LLM応答を逆置換（後→前）して表示する機能。opencodeチャット・RAGの全LLM境界と、ディスク上の.mdファイル一括置換をカバーする。

**Architecture:** 純粋関数の置換エンジンを `src/shared/lib/` に置き、ルールは既存の settings-store（zustand persist / localStorage `mdium-settings`）に保存。UIは左アクティビティバー（Gitボタン直下）から開く新パネル `src/features/replacement/`。opencodeチャット（`useOpencodeChat.ts`）とRAG（`useRagFeatures.ts` / `useRagBridge.ts`）の送受信点にエンジンを差し込む。

**Tech Stack:** React + TypeScript + zustand + i18next + vitest。Tauri コマンドは既存の `read_text_file` / `read_text_file_auto_encoding` / `write_text_file` を再利用（**Rust側の変更なし**）。

**Spec:** `.superpowers/specs/2026-07-04-replacement-design.md`

## Global Constraints

- コードコメントはすべて英語（CLAUDE.md）。
- UI表示文字列はハードコード禁止、必ずi18n（`ja`/`en`、新namespace `replacement`）（CLAUDE.md）。
- 置換マッチングはリテラル一致・大文字小文字区別あり・マッチ対象が長い順。正規表現なし。
- 置換は1パス走査（置換済み出力を再走査しない）。
- テストコマンド: `npm test`（= `vitest run`）。型チェック: `npx tsc --noEmit`。
- コミットは各タスク末尾で行う。コミットメッセージ末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- import は `@/` エイリアス（`@/shared/...`, `@/stores/...`）を使う。

---

### Task 1: 型定義と置換エンジン

**Files:**
- Modify: `src/shared/types/index.ts`（末尾に型追加）
- Create: `src/shared/lib/replacement.ts`
- Test: `src/shared/lib/__tests__/replacement.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `ReplacementRule { id: string; from: string; to: string; enabled: boolean }`（`@/shared/types`）
  - `ReplacementSettings { enabled: boolean; rules: ReplacementRule[] }`（`@/shared/types`）
  - `applyForward(text: string, settings: ReplacementSettings): string`
  - `applyForwardWithCount(text: string, settings: ReplacementSettings): { text: string; count: number }`
  - `applyReverse(text: string, settings: ReplacementSettings): string`
  - `applyReverseWithCount(text: string, settings: ReplacementSettings): { text: string; count: number }`
  - `findDuplicateTos(rules: ReplacementRule[]): string[]`

- [ ] **Step 1: 型を追加**

`src/shared/types/index.ts` の末尾に追加:

```ts
/** A single masking rule: `from` (sensitive string) -> `to` (alias). */
export interface ReplacementRule {
  id: string;
  from: string;
  to: string;
  enabled: boolean;
}

/** Replacement (masking) settings stored in the app settings store. */
export interface ReplacementSettings {
  enabled: boolean;
  rules: ReplacementRule[];
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/shared/lib/__tests__/replacement.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ReplacementRule, ReplacementSettings } from "@/shared/types";
import {
  applyForward,
  applyForwardWithCount,
  applyReverse,
  applyReverseWithCount,
  findDuplicateTos,
} from "../replacement";

function rule(from: string, to: string, enabled = true): ReplacementRule {
  return { id: `${from}->${to}`, from, to, enabled };
}

function settings(rules: ReplacementRule[], enabled = true): ReplacementSettings {
  return { enabled, rules };
}

describe("applyForward", () => {
  it("replaces all occurrences of from with to", () => {
    const s = settings([rule("株式会社A社", "会社X")]);
    expect(applyForward("株式会社A社と株式会社A社の件", s)).toBe("会社Xと会社Xの件");
  });

  it("is a no-op when master toggle is off", () => {
    const s = settings([rule("秘密", "S1")], false);
    expect(applyForward("秘密の話", s)).toBe("秘密の話");
  });

  it("skips disabled rules and rules with empty from/to", () => {
    const s = settings([
      rule("秘密", "S1", false),
      rule("", "X"),
      rule("公開", ""),
    ]);
    expect(applyForward("秘密と公開", s)).toBe("秘密と公開");
  });

  it("applies longer matches first (containment)", () => {
    const s = settings([rule("社名A", "X"), rule("社名A支店", "Y")]);
    expect(applyForward("社名A支店と社名A", s)).toBe("YとX");
  });

  it("does not re-scan replaced output (single pass)", () => {
    // to of rule1 equals from of rule2 — output must not be replaced again
    const s = settings([rule("田中", "社員"), rule("社員", "S")]);
    expect(applyForward("田中と社員", s)).toBe("社員とS");
  });

  it("is case-sensitive and literal", () => {
    const s = settings([rule("Host01", "srv-A")]);
    expect(applyForward("host01 Host01", s)).toBe("host01 srv-A");
  });
});

describe("applyForwardWithCount", () => {
  it("returns the number of replacements", () => {
    const s = settings([rule("秘密", "S1")]);
    expect(applyForwardWithCount("秘密、秘密、公開", s)).toEqual({
      text: "S1、S1、公開",
      count: 2,
    });
  });

  it("returns count 0 for unchanged text", () => {
    const s = settings([rule("秘密", "S1")]);
    expect(applyForwardWithCount("公開情報", s).count).toBe(0);
  });
});

describe("applyReverse", () => {
  it("replaces to back with from", () => {
    const s = settings([rule("株式会社A社", "会社X")]);
    expect(applyReverse("会社Xの担当", s)).toBe("株式会社A社の担当");
  });

  it("round-trips: reverse(forward(x)) === x", () => {
    const s = settings([
      rule("株式会社A社", "会社X"),
      rule("田中太郎", "担当P"),
      rule("hostname01.example.co.jp", "srv-A"),
    ]);
    const original = "田中太郎は株式会社A社のhostname01.example.co.jp を管理。";
    expect(applyReverse(applyForward(original, s), s)).toBe(original);
  });

  it("applies longer to-matches first", () => {
    const s = settings([rule("A社", "X"), rule("A社東京", "X東京支社")]);
    expect(applyReverse("X東京支社とX", s)).toBe("A社東京とA社");
  });
});

describe("applyReverseWithCount", () => {
  it("counts reverse replacements", () => {
    const s = settings([rule("秘密", "S1")]);
    expect(applyReverseWithCount("S1とS1", s)).toEqual({ text: "秘密と秘密", count: 2 });
  });
});

describe("findDuplicateTos", () => {
  it("returns to-values shared by multiple enabled rules", () => {
    const rules = [rule("a", "X"), rule("b", "X"), rule("c", "Y")];
    expect(findDuplicateTos(rules)).toEqual(["X"]);
  });

  it("ignores disabled rules and empty to", () => {
    const rules = [rule("a", "X"), rule("b", "X", false), rule("c", ""), rule("d", "")];
    expect(findDuplicateTos(rules)).toEqual([]);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npm test -- src/shared/lib/__tests__/replacement.test.ts`
Expected: FAIL（`../replacement` が存在しない）

- [ ] **Step 4: エンジンを実装**

`src/shared/lib/replacement.ts`:

```ts
import type { ReplacementRule, ReplacementSettings } from "@/shared/types";

interface Pair {
  search: string;
  replace: string;
}

export interface ApplyResult {
  text: string;
  count: number;
}

/**
 * Build the active search/replace pairs for a direction, sorted so that
 * longer search strings match first (prevents partial replacement when one
 * rule's string contains another's, e.g. "社名A支店" vs "社名A").
 */
function activePairs(
  settings: ReplacementSettings,
  direction: "forward" | "reverse",
): Pair[] {
  if (!settings.enabled) return [];
  return settings.rules
    .filter((r) => r.enabled && r.from.length > 0 && r.to.length > 0)
    .map((r) =>
      direction === "forward"
        ? { search: r.from, replace: r.to }
        : { search: r.to, replace: r.from },
    )
    .sort((a, b) => b.search.length - a.search.length);
}

/**
 * Single-pass scan replacement. Replaced output is never re-scanned, so a
 * rule whose `to` equals another rule's `from` cannot cause double
 * replacement. Literal, case-sensitive matching.
 */
function applyPairs(text: string, pairs: Pair[]): ApplyResult {
  if (pairs.length === 0 || text.length === 0) return { text, count: 0 };
  let out = "";
  let count = 0;
  let i = 0;
  scan: while (i < text.length) {
    for (const p of pairs) {
      if (text.startsWith(p.search, i)) {
        out += p.replace;
        i += p.search.length;
        count++;
        continue scan;
      }
    }
    out += text[i];
    i++;
  }
  return { text: out, count };
}

export function applyForwardWithCount(
  text: string,
  settings: ReplacementSettings,
): ApplyResult {
  return applyPairs(text, activePairs(settings, "forward"));
}

export function applyForward(text: string, settings: ReplacementSettings): string {
  return applyForwardWithCount(text, settings).text;
}

export function applyReverseWithCount(
  text: string,
  settings: ReplacementSettings,
): ApplyResult {
  return applyPairs(text, activePairs(settings, "reverse"));
}

export function applyReverse(text: string, settings: ReplacementSettings): string {
  return applyReverseWithCount(text, settings).text;
}

/**
 * Detect `to` values shared by multiple enabled rules — reverse replacement
 * is ambiguous for those. Used by the UI to show a warning.
 */
export function findDuplicateTos(rules: ReplacementRule[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rules) {
    if (!r.enabled || !r.to) continue;
    counts.set(r.to, (counts.get(r.to) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([to]) => to);
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test -- src/shared/lib/__tests__/replacement.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 6: コミット**

```bash
git add src/shared/types/index.ts src/shared/lib/replacement.ts src/shared/lib/__tests__/replacement.test.ts
git commit -m "feat(replacement): add replacement engine and types"
```

---

### Task 2: settings-store に置換設定を追加

**Files:**
- Modify: `src/stores/settings-store.ts`

**Interfaces:**
- Consumes: `ReplacementSettings`（Task 1）
- Produces:
  - `useSettingsStore` state に `replacement: ReplacementSettings`（デフォルト `{ enabled: false, rules: [] }`）
  - `setReplacement(settings: ReplacementSettings): void`
  - localStorage（`mdium-settings`）に永続化される

- [ ] **Step 1: ストアを変更**

`src/stores/settings-store.ts` に以下を追加:

import に `ReplacementSettings` を追加（8行目付近）:

```ts
import type { AiSettings, MediumSettings, RagSettings, ReplacementSettings } from "@/shared/types";
```

デフォルト定数（`DEFAULT_MEDIUM_SETTINGS` の下）:

```ts
const DEFAULT_REPLACEMENT_SETTINGS: ReplacementSettings = {
  enabled: false,
  rules: [],
};
```

`SettingsState` interface に（`allowLlmVbaImport: boolean;` の下）:

```ts
  replacement: ReplacementSettings;
```

setter宣言（`setAllowLlmVbaImport` の下）:

```ts
  setReplacement: (settings: ReplacementSettings) => void;
```

初期値（`allowLlmVbaImport: false,` の下）:

```ts
      replacement: DEFAULT_REPLACEMENT_SETTINGS,
```

setter実装（`setAllowLlmVbaImport: ...` の下）:

```ts
      setReplacement: (settings) => set({ replacement: settings }),
```

`partialize` に（`allowLlmVbaImport: state.allowLlmVbaImport,` の下）:

```ts
        replacement: state.replacement,
```

（`merge` の変更は不要 — 永続データに `replacement` が無い場合は `...current` のデフォルトが残る。）

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/stores/settings-store.ts
git commit -m "feat(replacement): persist replacement settings in settings store"
```

---

### Task 3: ルールCSVのパース・マージ・エクスポート

**Files:**
- Create: `src/features/replacement/lib/rules-csv.ts`
- Test: `src/features/replacement/lib/__tests__/rules-csv.test.ts`

**Interfaces:**
- Consumes: `ReplacementRule`（Task 1）
- Produces:
  - `CsvRowError { line: number; reason: "columnCount" | "boolValue" }`
  - `ParsedRulesCsv { rows: Array<{ from: string; to: string; enabled: boolean }>; errors: CsvRowError[] }`
  - `parseRulesCsv(text: string): ParsedRulesCsv` — 1行目（ヘッダー）は内容を検証せず読み飛ばす
  - `mergeRules(existing: ReplacementRule[], rows: ParsedRulesCsv["rows"]): { rules: ReplacementRule[]; added: number; updated: number }` — `from` 一致で上書き（冪等）、不一致は末尾追加
  - `exportRulesCsv(rules: ReplacementRule[]): string` — ヘッダー付きCRLF、RFC4180クォート。**BOMは含まない**（書き込み時に呼び出し側が `"\uFEFF"` を前置する）

- [ ] **Step 1: 失敗するテストを書く**

`src/features/replacement/lib/__tests__/rules-csv.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ReplacementRule } from "@/shared/types";
import { parseRulesCsv, mergeRules, exportRulesCsv } from "../rules-csv";

const HEADER = "置換前文字列,置換後文字列,有効";

describe("parseRulesCsv", () => {
  it("parses a simple 3-column CSV, skipping the header", () => {
    const csv = `${HEADER}\r\n株式会社A社,会社X,true\r\n田中太郎,担当P,false\r\n`;
    const result = parseRulesCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { from: "株式会社A社", to: "会社X", enabled: true },
      { from: "田中太郎", to: "担当P", enabled: false },
    ]);
  });

  it("accepts LF line endings and a leading BOM", () => {
    const csv = "\uFEFF" + `${HEADER}\na,b,1\nc,d,0\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toEqual([
      { from: "a", to: "b", enabled: true },
      { from: "c", to: "d", enabled: false },
    ]);
  });

  it("parses quoted fields containing commas, quotes, and newlines", () => {
    const csv = `${HEADER}\r\n"a,b","c""d",TRUE\r\n"line1\nline2",x,false\r\n`;
    const result = parseRulesCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toEqual({ from: "a,b", to: 'c"d', enabled: true });
    expect(result.rows[1]).toEqual({ from: "line1\nline2", to: "x", enabled: false });
  });

  it("reports rows with wrong column count (with 1-based line numbers)", () => {
    const csv = `${HEADER}\na,b,true\nonly-two,cols\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([{ line: 3, reason: "columnCount" }]);
  });

  it("reports rows with unparseable bool", () => {
    const csv = `${HEADER}\na,b,yes\nc,d,true\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toEqual([{ from: "c", to: "d", enabled: true }]);
    expect(result.errors).toEqual([{ line: 2, reason: "boolValue" }]);
  });

  it("skips blank lines without errors", () => {
    const csv = `${HEADER}\n\na,b,true\n\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });
});

describe("mergeRules", () => {
  const existing: ReplacementRule[] = [
    { id: "1", from: "a", to: "OLD", enabled: false },
    { id: "2", from: "keep", to: "K", enabled: true },
  ];

  it("overwrites by from-match and appends new rows", () => {
    const { rules, added, updated } = mergeRules(existing, [
      { from: "a", to: "NEW", enabled: true },
      { from: "b", to: "B", enabled: true },
    ]);
    expect(added).toBe(1);
    expect(updated).toBe(1);
    expect(rules).toHaveLength(3);
    const a = rules.find((r) => r.from === "a")!;
    expect(a).toMatchObject({ id: "1", to: "NEW", enabled: true });
    expect(rules.find((r) => r.from === "b")).toBeTruthy();
  });

  it("is idempotent: re-importing the same rows reports 0 added / 0 updated", () => {
    const rows = [{ from: "a", to: "NEW", enabled: true }];
    const first = mergeRules(existing, rows);
    const second = mergeRules(first.rules, rows);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.rules).toEqual(first.rules);
  });

  it("does not mutate the input array", () => {
    mergeRules(existing, [{ from: "a", to: "NEW", enabled: true }]);
    expect(existing[0].to).toBe("OLD");
  });
});

describe("exportRulesCsv", () => {
  it("writes header + rows with CRLF and quotes fields when needed", () => {
    const rules: ReplacementRule[] = [
      { id: "1", from: "a,b", to: 'c"d', enabled: true },
      { id: "2", from: "plain", to: "x", enabled: false },
    ];
    expect(exportRulesCsv(rules)).toBe(
      `${HEADER}\r\n"a,b","c""d",true\r\nplain,x,false\r\n`,
    );
  });

  it("round-trips through parseRulesCsv", () => {
    const rules: ReplacementRule[] = [
      { id: "1", from: "株式会社A社", to: "会社X", enabled: true },
      { id: "2", from: "multi\nline", to: "a,b", enabled: false },
    ];
    const parsed = parseRulesCsv(exportRulesCsv(rules));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(
      rules.map(({ from, to, enabled }) => ({ from, to, enabled })),
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- src/features/replacement/lib/__tests__/rules-csv.test.ts`
Expected: FAIL（`../rules-csv` が存在しない）

- [ ] **Step 3: 実装**

`src/features/replacement/lib/rules-csv.ts`:

```ts
import type { ReplacementRule } from "@/shared/types";

export interface CsvRowError {
  line: number;
  reason: "columnCount" | "boolValue";
}

export interface ParsedRulesCsv {
  rows: Array<{ from: string; to: string; enabled: boolean }>;
  errors: CsvRowError[];
}

interface CsvRecord {
  fields: string[];
  /** 1-based line number where this record starts. */
  line: number;
}

/**
 * RFC4180-style CSV tokenizer. Handles quoted fields containing commas,
 * escaped quotes ("") and embedded newlines. Accepts CRLF and LF.
 */
function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let fieldHadQuotes = false;
  let recordHadContent = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endField = () => {
    fields.push(field);
    field = "";
    if (fieldHadQuotes) recordHadContent = true;
    fieldHadQuotes = false;
  };
  const endRecord = () => {
    endField();
    // Skip blank lines (a single empty unquoted field).
    if (recordHadContent || fields.length > 1 || fields[0] !== "") {
      records.push({ fields, line: recordLine });
    }
    fields = [];
    recordHadContent = false;
    recordLine = line;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === "\n") line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      fieldHadQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      recordHadContent = true;
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      line++;
      endRecord();
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      line++;
      endRecord();
      i++;
      continue;
    }
    field += ch;
    recordHadContent = true;
    i++;
  }
  if (field !== "" || fields.length > 0 || fieldHadQuotes) {
    endRecord();
  }
  return records;
}

function parseBool(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

/**
 * Parse a rules CSV: header row (skipped, content not validated) followed by
 * 3-column records "from,to,enabled". Malformed rows are reported in
 * `errors` with their 1-based line numbers; valid rows are still returned.
 */
export function parseRulesCsv(text: string): ParsedRulesCsv {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = parseCsvRecords(body);
  const rows: ParsedRulesCsv["rows"] = [];
  const errors: CsvRowError[] = [];
  // records[0] is the header — skip it.
  for (const record of records.slice(1)) {
    if (record.fields.length !== 3) {
      errors.push({ line: record.line, reason: "columnCount" });
      continue;
    }
    const enabled = parseBool(record.fields[2]);
    if (enabled === null) {
      errors.push({ line: record.line, reason: "boolValue" });
      continue;
    }
    rows.push({ from: record.fields[0], to: record.fields[1], enabled });
  }
  return { rows, errors };
}

/**
 * Merge imported rows into existing rules. Rows whose `from` matches an
 * existing rule overwrite its `to`/`enabled` (keeping the id); others are
 * appended. Re-importing the same CSV is a no-op (idempotent).
 */
export function mergeRules(
  existing: ReplacementRule[],
  rows: ParsedRulesCsv["rows"],
): { rules: ReplacementRule[]; added: number; updated: number } {
  const rules = existing.map((r) => ({ ...r }));
  const byFrom = new Map(rules.map((r) => [r.from, r]));
  let added = 0;
  let updated = 0;
  for (const row of rows) {
    const hit = byFrom.get(row.from);
    if (hit) {
      if (hit.to !== row.to || hit.enabled !== row.enabled) {
        hit.to = row.to;
        hit.enabled = row.enabled;
        updated++;
      }
    } else {
      const rule: ReplacementRule = {
        id: crypto.randomUUID(),
        from: row.from,
        to: row.to,
        enabled: row.enabled,
      };
      rules.push(rule);
      byFrom.set(rule.from, rule);
      added++;
    }
  }
  return { rules, added, updated };
}

export const RULES_CSV_HEADER = "置換前文字列,置換後文字列,有効";

function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize rules to the same 3-column CSV format accepted by
 * parseRulesCsv (round-trip safe). CRLF line endings for Excel. The caller
 * prepends a BOM ("\uFEFF") when writing to disk.
 */
export function exportRulesCsv(rules: ReplacementRule[]): string {
  const lines = [
    RULES_CSV_HEADER,
    ...rules.map(
      (r) =>
        `${escapeCsvField(r.from)},${escapeCsvField(r.to)},${r.enabled ? "true" : "false"}`,
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- src/features/replacement/lib/__tests__/rules-csv.test.ts`
Expected: PASS。失敗したらトークナイザの行番号・空行スキップ処理をテスト期待値に合わせて修正する（期待値仕様が正）。

- [ ] **Step 5: コミット**

```bash
git add src/features/replacement/lib/rules-csv.ts src/features/replacement/lib/__tests__/rules-csv.test.ts
git commit -m "feat(replacement): add rules CSV parse/merge/export"
```

---

### Task 4: 一括置換ロジック

**Files:**
- Create: `src/features/replacement/lib/bulk-replace.ts`
- Test: `src/features/replacement/lib/__tests__/bulk-replace.test.ts`

**Interfaces:**
- Consumes: `applyForwardWithCount` / `applyReverseWithCount`（Task 1）、`FileEntry`（`@/shared/types`、`{ name, path, is_dir, children }`）
- Produces:
  - `collectMdPaths(tree: FileEntry[]): string[]` — `.md`（小文字比較）のみ。名前が `.` で始まるディレクトリ（`.mdium` 含む）と `node_modules` はスキップ
  - `BulkReplaceSummary { changedPaths: string[]; totalReplacements: number; failed: Array<{ path: string; error: string }> }`
  - `runBulkReplace(paths: string[], settings: ReplacementSettings, direction: "forward" | "reverse"): Promise<BulkReplaceSummary>` — Tauri `read_text_file` / `write_text_file` を使用。変更のないファイルは書き込まない

- [ ] **Step 1: 失敗するテストを書く**

`src/features/replacement/lib/__tests__/bulk-replace.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry, ReplacementSettings } from "@/shared/types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { collectMdPaths, runBulkReplace } from "../bulk-replace";

function dir(name: string, children: FileEntry[]): FileEntry {
  return { name, path: `/root/${name}`, is_dir: true, children };
}
function file(name: string, path = `/root/${name}`): FileEntry {
  return { name, path, is_dir: false, children: null };
}

describe("collectMdPaths", () => {
  it("collects .md files recursively, skipping dot-dirs and node_modules", () => {
    const tree: FileEntry[] = [
      file("a.md"),
      file("b.txt"),
      file("UPPER.MD", "/root/UPPER.MD"),
      dir("sub", [file("c.md", "/root/sub/c.md")]),
      dir(".mdium", [file("x.md", "/root/.mdium/x.md")]),
      dir(".git", [file("y.md", "/root/.git/y.md")]),
      dir("node_modules", [file("z.md", "/root/node_modules/z.md")]),
    ];
    expect(collectMdPaths(tree)).toEqual(["/root/a.md", "/root/UPPER.MD", "/root/sub/c.md"]);
  });
});

describe("runBulkReplace", () => {
  const settings: ReplacementSettings = {
    enabled: true,
    rules: [{ id: "1", from: "秘密", to: "S1", enabled: true }],
  };

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("rewrites files containing matches and reports counts", async () => {
    const contents: Record<string, string> = {
      "/root/a.md": "秘密の話と秘密",
      "/root/b.md": "何もなし",
    };
    const written: Record<string, string> = {};
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_text_file") return contents[args.path];
      if (cmd === "write_text_file") {
        written[args.path] = args.content;
        return undefined;
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const summary = await runBulkReplace(["/root/a.md", "/root/b.md"], settings, "forward");
    expect(summary.changedPaths).toEqual(["/root/a.md"]);
    expect(summary.totalReplacements).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(written["/root/a.md"]).toBe("S1の話とS1");
    expect(written["/root/b.md"]).toBeUndefined();
  });

  it("runs reverse direction", async () => {
    const written: Record<string, string> = {};
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_text_file") return "S1の話";
      if (cmd === "write_text_file") {
        written[args.path] = args.content;
        return undefined;
      }
    });
    const summary = await runBulkReplace(["/root/a.md"], settings, "reverse");
    expect(written["/root/a.md"]).toBe("秘密の話");
    expect(summary.totalReplacements).toBe(1);
  });

  it("collects per-file errors and continues", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_text_file") {
        if (args.path === "/root/bad.md") throw new Error("boom");
        return "秘密";
      }
      if (cmd === "write_text_file") return undefined;
    });
    const summary = await runBulkReplace(["/root/bad.md", "/root/ok.md"], settings, "forward");
    expect(summary.failed).toEqual([{ path: "/root/bad.md", error: expect.stringContaining("boom") }]);
    expect(summary.changedPaths).toEqual(["/root/ok.md"]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- src/features/replacement/lib/__tests__/bulk-replace.test.ts`
Expected: FAIL（`../bulk-replace` が存在しない）

- [ ] **Step 3: 実装**

`src/features/replacement/lib/bulk-replace.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry, ReplacementSettings } from "@/shared/types";
import { applyForwardWithCount, applyReverseWithCount } from "@/shared/lib/replacement";

/**
 * Collect all .md file paths from a FileEntry tree. Dot-directories
 * (including .mdium) and node_modules are skipped so index/database files
 * are never rewritten.
 */
export function collectMdPaths(tree: FileEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of tree) {
    if (entry.is_dir) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.children) paths.push(...collectMdPaths(entry.children));
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      paths.push(entry.path);
    }
  }
  return paths;
}

export interface BulkReplaceSummary {
  changedPaths: string[];
  totalReplacements: number;
  failed: Array<{ path: string; error: string }>;
}

/**
 * Rewrite files on disk applying the replacement rules in the given
 * direction. Files without matches are left untouched. Per-file failures
 * are collected and do not abort the run.
 */
export async function runBulkReplace(
  paths: string[],
  settings: ReplacementSettings,
  direction: "forward" | "reverse",
): Promise<BulkReplaceSummary> {
  const apply = direction === "forward" ? applyForwardWithCount : applyReverseWithCount;
  const summary: BulkReplaceSummary = { changedPaths: [], totalReplacements: 0, failed: [] };
  for (const path of paths) {
    try {
      const content = await invoke<string>("read_text_file", { path });
      const { text, count } = apply(content, settings);
      if (count === 0 || text === content) continue;
      await invoke("write_text_file", { path, content: text });
      summary.changedPaths.push(path);
      summary.totalReplacements += count;
    } catch (e) {
      summary.failed.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- src/features/replacement/lib/__tests__/bulk-replace.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/features/replacement/lib/bulk-replace.ts src/features/replacement/lib/__tests__/bulk-replace.test.ts
git commit -m "feat(replacement): add bulk file replace logic"
```

---

### Task 5: i18nリソースと置換パネル（ルール編集）＋アクティビティバー配線

**Files:**
- Create: `src/shared/i18n/locales/ja/replacement.json`
- Create: `src/shared/i18n/locales/en/replacement.json`
- Modify: `src/shared/i18n/index.ts`
- Create: `src/features/replacement/components/ReplacementPanel.tsx`
- Create: `src/features/replacement/components/ReplacementPanel.css`
- Modify: `src/stores/ui-store.ts:4`（`LeftPanel` 型）
- Modify: `src/features/file-tree/components/LeftPanel.tsx`（ボタン・ヘッダー・パネル描画）

**Interfaces:**
- Consumes: `useSettingsStore`（`replacement` / `setReplacement`、Task 2）、`findDuplicateTos`（Task 1）
- Produces:
  - `<ReplacementPanel />`（props なし）— 左パネル領域に描画される
  - `LeftPanel` 型に `"replacement"` が追加され、アクティビティバーから遷移可能
  - i18n namespace `replacement`

- [ ] **Step 1: i18nリソースを作成**

`src/shared/i18n/locales/ja/replacement.json`:

```json
{
  "title": "置換",
  "enabled": "有効",
  "addRule": "ルール追加",
  "fromPlaceholder": "置換前",
  "toPlaceholder": "置換後",
  "deleteRule": "削除",
  "duplicateToWarning": "置換後文字列「{{value}}」が複数のルールで使われています（逆置換が曖昧になります）",
  "sectionCsv": "CSV",
  "importCsv": "CSVインポート",
  "exportCsv": "CSVエクスポート",
  "importResult": "インポート完了: 追加 {{added}} 件・更新 {{updated}} 件・エラー {{errors}} 件",
  "importErrorLine": "{{line}}行目: {{reason}}",
  "reasonColumnCount": "列数が3ではありません",
  "reasonBoolValue": "有効列の値を解釈できません",
  "exportDone": "エクスポートしました",
  "sectionBulk": "ファイル一括変換",
  "bulkForward": "一括置換（前→後）",
  "bulkReverse": "一括逆置換（後→前）",
  "bulkConfirm": "{{folder}} 内の {{count}} 個の .md ファイルを書き換えます。バックアップは作成されません（gitでの復元を前提とします）。実行しますか？",
  "bulkDone": "{{files}} ファイル・{{replacements}} 箇所を置換しました。",
  "bulkNoTargets": "対象の .md ファイルがありません。",
  "bulkSkippedDirty": "未保存のため {{count}} ファイルをスキップしました。",
  "bulkFailed": "失敗: {{count}} ファイル",
  "ragReindexNote": "一括置換後はRAGインデックスの再構築を推奨します。",
  "noFolder": "フォルダが開かれていません。",
  "guidance": "LLMへ送信される文字列を「置換前」→「置換後」にマスクし、応答は逆置換して表示します。ファイル内容もマスクするには一括置換を実行してください。"
}
```

`src/shared/i18n/locales/en/replacement.json`:

```json
{
  "title": "Replacement",
  "enabled": "Enabled",
  "addRule": "Add rule",
  "fromPlaceholder": "Original",
  "toPlaceholder": "Alias",
  "deleteRule": "Delete",
  "duplicateToWarning": "Alias \"{{value}}\" is used by multiple rules (reverse replacement is ambiguous)",
  "sectionCsv": "CSV",
  "importCsv": "Import CSV",
  "exportCsv": "Export CSV",
  "importResult": "Import finished: {{added}} added, {{updated}} updated, {{errors}} errors",
  "importErrorLine": "Line {{line}}: {{reason}}",
  "reasonColumnCount": "Row does not have 3 columns",
  "reasonBoolValue": "Cannot parse the enabled column",
  "exportDone": "Exported.",
  "sectionBulk": "Bulk file conversion",
  "bulkForward": "Bulk replace (mask)",
  "bulkReverse": "Bulk reverse (unmask)",
  "bulkConfirm": "This will rewrite {{count}} .md file(s) under {{folder}}. No backup is created (git is assumed for recovery). Continue?",
  "bulkDone": "Replaced {{replacements}} occurrence(s) across {{files}} file(s).",
  "bulkNoTargets": "No target .md files.",
  "bulkSkippedDirty": "Skipped {{count}} file(s) with unsaved changes.",
  "bulkFailed": "Failed: {{count}} file(s)",
  "ragReindexNote": "Rebuilding the RAG index is recommended after a bulk replace.",
  "noFolder": "No folder is open.",
  "guidance": "Strings sent to the LLM are masked (original → alias) and responses are unmasked for display. Run a bulk replace to also mask file contents."
}
```

- [ ] **Step 2: i18nに登録**

`src/shared/i18n/index.ts` に追加（`jaCsv`/`enCsv` import の下）:

```ts
import jaReplacement from "./locales/ja/replacement.json";
import enReplacement from "./locales/en/replacement.json";
```

`resources.ja` に `replacement: jaReplacement,`、`resources.en` に `replacement: enReplacement,` を追加。

- [ ] **Step 3: ui-store の LeftPanel 型を拡張**

`src/stores/ui-store.ts:4` を変更:

```ts
export type LeftPanel = "folder" | "outline" | "rag" | "opencode-config" | "git" | "replacement";
```

- [ ] **Step 4: ReplacementPanel（ルール編集のみ、CSV/一括はTask 6-7で追加）を作成**

`src/features/replacement/components/ReplacementPanel.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settings-store";
import { findDuplicateTos } from "@/shared/lib/replacement";
import type { ReplacementRule } from "@/shared/types";
import "./ReplacementPanel.css";

export function ReplacementPanel() {
  const { t } = useTranslation("replacement");
  const replacement = useSettingsStore((s) => s.replacement);
  const setReplacement = useSettingsStore((s) => s.setReplacement);

  const duplicateTos = findDuplicateTos(replacement.rules);

  const updateRule = (id: string, patch: Partial<ReplacementRule>) => {
    setReplacement({
      ...replacement,
      rules: replacement.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  };

  const addRule = () => {
    setReplacement({
      ...replacement,
      rules: [
        ...replacement.rules,
        { id: crypto.randomUUID(), from: "", to: "", enabled: true },
      ],
    });
  };

  const deleteRule = (id: string) => {
    setReplacement({
      ...replacement,
      rules: replacement.rules.filter((r) => r.id !== id),
    });
  };

  return (
    <div className="replacement-panel">
      <p className="replacement-panel__guidance">{t("guidance")}</p>

      <div className="replacement-panel__header">
        <label className="replacement-panel__toggle">
          <input
            type="checkbox"
            checked={replacement.enabled}
            onChange={(e) => setReplacement({ ...replacement, enabled: e.target.checked })}
          />
          {t("enabled")}
        </label>
        <button className="replacement-panel__btn" onClick={addRule}>
          + {t("addRule")}
        </button>
      </div>

      <div className="replacement-panel__rules">
        {replacement.rules.map((rule) => (
          <div className="replacement-panel__rule" key={rule.id}>
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
            />
            <input
              type="text"
              className={`replacement-panel__input${rule.from === "" ? " replacement-panel__input--invalid" : ""}`}
              value={rule.from}
              placeholder={t("fromPlaceholder")}
              onChange={(e) => updateRule(rule.id, { from: e.target.value })}
            />
            <span className="replacement-panel__arrow">→</span>
            <input
              type="text"
              className="replacement-panel__input"
              value={rule.to}
              placeholder={t("toPlaceholder")}
              onChange={(e) => updateRule(rule.id, { to: e.target.value })}
            />
            <button
              className="replacement-panel__icon-btn"
              onClick={() => deleteRule(rule.id)}
              title={t("deleteRule")}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {duplicateTos.map((to) => (
        <p className="replacement-panel__warning" key={to}>
          ⚠ {t("duplicateToWarning", { value: to })}
        </p>
      ))}
    </div>
  );
}
```

`src/features/replacement/components/ReplacementPanel.css`:

```css
.replacement-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  height: 100%;
  font-size: 12px;
}

.replacement-panel__guidance {
  margin: 0;
  color: var(--text-secondary, #888);
  font-size: 11px;
  line-height: 1.5;
}

.replacement-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.replacement-panel__toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.replacement-panel__btn {
  background: var(--button-bg, #2d2d2d);
  color: inherit;
  border: 1px solid var(--border-color, #444);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 12px;
}

.replacement-panel__btn:hover {
  background: var(--button-hover-bg, #3d3d3d);
}

.replacement-panel__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.replacement-panel__rules {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.replacement-panel__rule {
  display: flex;
  align-items: center;
  gap: 4px;
}

.replacement-panel__input {
  flex: 1;
  min-width: 0;
  background: var(--input-bg, #1e1e1e);
  color: inherit;
  border: 1px solid var(--border-color, #444);
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 12px;
}

.replacement-panel__input--invalid {
  border-color: var(--error-color, #e05555);
}

.replacement-panel__arrow {
  flex: 0 0 auto;
  color: var(--text-secondary, #888);
}

.replacement-panel__icon-btn {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: var(--text-secondary, #888);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.replacement-panel__icon-btn:hover {
  color: var(--error-color, #e05555);
}

.replacement-panel__warning {
  margin: 0;
  color: var(--warning-color, #d8a03d);
  font-size: 11px;
}

.replacement-panel__section {
  border-top: 1px solid var(--border-color, #444);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.replacement-panel__section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary, #888);
  text-transform: uppercase;
}

.replacement-panel__row {
  display: flex;
  gap: 6px;
}

.replacement-panel__note {
  margin: 0;
  color: var(--text-secondary, #888);
  font-size: 11px;
  line-height: 1.5;
}
```

- [ ] **Step 5: アクティビティバーに配線**

`src/features/file-tree/components/LeftPanel.tsx`:

import追加（`GitPanel` import の下）:

```tsx
import { ReplacementPanel } from "@/features/replacement/components/ReplacementPanel";
```

Gitボタン（`title={t("sourceControl", { ns: "git" })}` のボタン、112-126行付近）の**直後**にボタンを追加:

```tsx
          <button
            className={`left-panel__activity-btn ${leftPanel === "replacement" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => { setLeftPanel("replacement"); setFolderLeftPanel("replacement"); }}
            title={t("title", { ns: "replacement" })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
          </button>
```

セクションヘッダー（`{leftPanel === "git" && ...}` の行の下、208行付近）に追加:

```tsx
            {leftPanel === "replacement" && t("title", { ns: "replacement" }).toUpperCase()}
```

パネル描画（`{leftPanel === "git" && <GitPanel />}` の行、363行付近の下）に追加:

```tsx
        {leftPanel === "replacement" && <ReplacementPanel />}
```

注意: `setFolderLeftPanel` の引数型が `LeftPanel` を参照していない場合（別union定義の場合）は `src/stores/tab-store.ts` の該当型にも `"replacement"` を追加する。`npx tsc --noEmit` で検出する。

- [ ] **Step 6: 型チェックと目視確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

Run: `npm run tauri dev`（または `npm run dev`）を起動し、左バーのGitアイコン下に置換ボタンが出ること、パネルでルールの追加・編集・削除・トグルができること、リロード後もルールが残る（localStorage永続化）ことを確認して終了。

- [ ] **Step 7: コミット**

```bash
git add src/shared/i18n src/features/replacement/components src/stores/ui-store.ts src/features/file-tree/components/LeftPanel.tsx
git commit -m "feat(replacement): add replacement panel and activity bar entry"
```

---

### Task 6: CSVインポート・エクスポートのUI配線

**Files:**
- Modify: `src/features/replacement/components/ReplacementPanel.tsx`

**Interfaces:**
- Consumes: `parseRulesCsv` / `mergeRules` / `exportRulesCsv`（Task 3）、Tauri `read_text_file_auto_encoding`（BOM/UTF-16/UTF-8/Shift_JIS自動判別、Rust実装済み `src-tauri/src/commands/file.rs:42`）、`write_text_file`、`@tauri-apps/plugin-dialog` の `open`/`save`、`showMessage`（`@/stores/dialog-store`）
- Produces: パネル内「CSVインポート」「CSVエクスポート」ボタン

- [ ] **Step 1: パネルにインポート/エクスポート処理を追加**

`ReplacementPanel.tsx` の import に追加:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { showMessage } from "@/stores/dialog-store";
import { parseRulesCsv, mergeRules, exportRulesCsv } from "../lib/rules-csv";
```

コンポーネント内にハンドラを追加（`deleteRule` の下）:

```tsx
  const handleImportCsv = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const raw = await invoke<string>("read_text_file_auto_encoding", { path: selected });
      const { rows, errors } = parseRulesCsv(raw);
      const { rules, added, updated } = mergeRules(replacement.rules, rows);
      setReplacement({ ...replacement, rules });
      let msg = t("importResult", { added, updated, errors: errors.length });
      if (errors.length > 0) {
        const lines = errors.slice(0, 10).map((err) =>
          t("importErrorLine", {
            line: err.line,
            reason: t(err.reason === "columnCount" ? "reasonColumnCount" : "reasonBoolValue"),
          }),
        );
        msg += "\n" + lines.join("\n");
      }
      await showMessage(msg, { kind: errors.length > 0 ? "warning" : "info" });
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  };

  const handleExportCsv = async () => {
    const path = await save({
      defaultPath: "replacement-rules.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    try {
      // BOM so Excel opens the UTF-8 file with correct Japanese text.
      await invoke("write_text_file", { path, content: "\uFEFF" + exportRulesCsv(replacement.rules) });
      await showMessage(t("exportDone"));
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  };
```

JSXの警告表示（`duplicateTos.map(...)`）の下にセクションを追加:

```tsx
      <div className="replacement-panel__section">
        <span className="replacement-panel__section-title">{t("sectionCsv")}</span>
        <div className="replacement-panel__row">
          <button className="replacement-panel__btn" onClick={handleImportCsv}>
            {t("importCsv")}
          </button>
          <button className="replacement-panel__btn" onClick={handleExportCsv}>
            {t("exportCsv")}
          </button>
        </div>
      </div>
```

注意: `showMessage` / `showConfirm` の `kind` に指定できる値は `src/stores/dialog-store.ts` の `DialogKind` を確認し、存在しない値（例: `"info"`/`"error"`）なら省略またはその型に合わせる。

- [ ] **Step 2: 型チェックと動作確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

アプリを起動し、次のCSV（Shift_JISでも可）を作ってインポート→件数報告、再インポート→追加0/更新0（冪等）、エクスポート→Excelで開けること・再インポートできることを確認:

```csv
置換前文字列,置換後文字列,有効
株式会社A社,会社X,true
田中太郎,担当P,1
```

- [ ] **Step 3: コミット**

```bash
git add src/features/replacement/components/ReplacementPanel.tsx
git commit -m "feat(replacement): wire CSV import/export in panel"
```

---

### Task 7: 一括置換・一括逆置換のUI配線

**Files:**
- Modify: `src/features/replacement/components/ReplacementPanel.tsx`

**Interfaces:**
- Consumes: `collectMdPaths` / `runBulkReplace`（Task 4）、`useTabStore`（`activeFolderPath`, `tabs[].filePath/dirty/id`, `updateTabContent`, `markClean`）、`useFileStore`（`fileTrees`）、`showConfirm`（`@/stores/dialog-store`）
- Produces: パネル内「一括置換（前→後）」「一括逆置換（後→前）」ボタン（確認→実行→クリーンタブ再読込→結果報告）

- [ ] **Step 1: 一括変換ハンドラを追加**

`ReplacementPanel.tsx` の import に追加:

```tsx
import { useState } from "react";
import { showConfirm } from "@/stores/dialog-store";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore } from "@/stores/file-store";
import { collectMdPaths, runBulkReplace } from "../lib/bulk-replace";
```

コンポーネント内に追加:

```tsx
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const [bulkRunning, setBulkRunning] = useState(false);

  const hasActiveRules = replacement.enabled &&
    replacement.rules.some((r) => r.enabled && r.from && r.to);

  const handleBulk = async (direction: "forward" | "reverse") => {
    if (!activeFolderPath) {
      await showMessage(t("noFolder"), { kind: "warning" });
      return;
    }
    const tree = useFileStore.getState().fileTrees[activeFolderPath] ?? [];
    const allPaths = collectMdPaths(tree);
    // Files with unsaved editor changes are excluded: rewriting them on disk
    // would silently lose the user's in-memory edits on the next save.
    const dirtyPaths = new Set(
      useTabStore.getState().tabs
        .filter((tab) => tab.dirty && tab.filePath)
        .map((tab) => tab.filePath as string),
    );
    const paths = allPaths.filter((p) => !dirtyPaths.has(p));
    const skippedDirty = allPaths.length - paths.length;
    if (paths.length === 0) {
      await showMessage(t("bulkNoTargets"), { kind: "warning" });
      return;
    }
    const ok = await showConfirm(
      t("bulkConfirm", { folder: activeFolderPath, count: paths.length }),
      { kind: "warning" },
    );
    if (!ok) return;

    setBulkRunning(true);
    try {
      const summary = await runBulkReplace(paths, replacement, direction);

      // Reload clean tabs whose file was rewritten so the editor shows the
      // new on-disk content.
      const changed = new Set(summary.changedPaths);
      for (const tab of useTabStore.getState().tabs) {
        if (tab.filePath && changed.has(tab.filePath) && !tab.dirty) {
          try {
            const content = await invoke<string>("read_text_file", { path: tab.filePath });
            useTabStore.getState().updateTabContent(tab.id, content);
            useTabStore.getState().markClean(tab.id);
          } catch {
            // Tab reload is best-effort; the file itself was already rewritten.
          }
        }
      }

      const lines = [
        t("bulkDone", {
          files: summary.changedPaths.length,
          replacements: summary.totalReplacements,
        }),
      ];
      if (skippedDirty > 0) lines.push(t("bulkSkippedDirty", { count: skippedDirty }));
      if (summary.failed.length > 0) lines.push(t("bulkFailed", { count: summary.failed.length }));
      lines.push(t("ragReindexNote"));
      await showMessage(lines.join("\n"));
    } finally {
      setBulkRunning(false);
    }
  };
```

JSXのCSVセクションの下に追加:

```tsx
      <div className="replacement-panel__section">
        <span className="replacement-panel__section-title">{t("sectionBulk")}</span>
        <div className="replacement-panel__row">
          <button
            className="replacement-panel__btn"
            disabled={bulkRunning || !hasActiveRules}
            onClick={() => handleBulk("forward")}
          >
            {t("bulkForward")}
          </button>
          <button
            className="replacement-panel__btn"
            disabled={bulkRunning || !hasActiveRules}
            onClick={() => handleBulk("reverse")}
          >
            {t("bulkReverse")}
          </button>
        </div>
        <p className="replacement-panel__note">{t("ragReindexNote")}</p>
      </div>
```

注意: `useFileStore` の state 形状（`fileTrees[folderPath]`）は `LeftPanel.tsx:63-65` の利用例に合わせる。`updateTabContent` / `markClean` のシグネチャは `App.tsx:168-169` の利用例（`(id, content)` / `(id)`) に合わせる。

- [ ] **Step 2: 型チェックと動作確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

アプリで確認: テスト用フォルダを開き、ルール（例: `秘密→S1`）を有効にして一括置換→確認ダイアログ→.mdが書き換わり件数表示・開いているタブが更新される。一括逆置換で元に戻る。未保存タブがある場合スキップ報告が出る。

- [ ] **Step 3: コミット**

```bash
git add src/features/replacement/components/ReplacementPanel.tsx
git commit -m "feat(replacement): wire bulk replace/reverse buttons"
```

---

### Task 8: opencodeチャットへの統合

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

**Interfaces:**
- Consumes: `applyForward` / `applyReverse`（Task 1）、`useSettingsStore.getState().replacement`（Task 2）
- Produces: opencodeチャットの送信テキストがマスクされ、受信テキスト（ストリーミング・最終化・履歴・質問カード）が逆置換されて表示される

**変更一覧（すべて `useOpencodeChat.ts` 内）:**

- [ ] **Step 1: import とヘルパーを追加**

ファイル先頭のimport群に追加（`useSettingsStore` が未importの場合のみ追加）:

```ts
import { useSettingsStore } from "@/stores/settings-store";
import { applyForward, applyReverse } from "@/shared/lib/replacement";
```

`wrapWithMdiumContext` 関数の直後にヘルパーを追加:

```ts
/** Current replacement (masking) settings, read at call time. */
function replacementSettings() {
  return useSettingsStore.getState().replacement;
}
```

- [ ] **Step 2: 送信経路にforward適用**

(a) `doSendMessage`（1219行付近）:

```ts
  // L1: inject active tab context into every user message payload (SDK call only)
  const wrappedText = applyForward(await wrapWithMdiumContext(text), replacementSettings());
```

（`displayText` は原文 `text` のままなので変更不要。）

(b) `doExecuteCommand`（1423-1426行付近）: SDK呼び出しの `arguments` のみマスクし、`displayText` は原文のまま:

```ts
    const res = await _client.session.command({
      path: { id: sessionId },
      body: {
        command: commandName,
        arguments: args ? applyForward(args, replacementSettings()) : "",
      },
    });
```

(c) `doAnswerQuestions`（1338-1343行付近）: v2返信のanswersをマスク（legacyパスは `doSendMessage` 経由なので(a)でカバー済み）:

```ts
        body: JSON.stringify({
          answers: answers.map((group) =>
            group.map((a) => applyForward(a, replacementSettings())),
          ),
        }),
```

- [ ] **Step 3: ストリーミング受信にreverse適用**

`processSSEStream` の `text` パート処理（527-544行付近）。`textContent` 算出後を次のように変更:

```ts
                const textContent = newParts
                  .filter((p) => p.type === "text")
                  .map((p) => (p as any).text ?? "")
                  .join("");
                // Unmask for display; parts keep the raw (masked) SDK payload.
                const displayContent = applyReverse(textContent, replacementSettings());
                updated[updated.length - 1] = {
                  ...last,
                  content: displayContent,
                  parts: newParts,
                };

                // Detect questions JSON and unlock loading
                const questions = tryParseQuestions(displayContent);
```

- [ ] **Step 4: session.idle 最終化にreverse適用**

エコー除去ブロック（672-687行付近）。`parts` の生テキストはマスク済み、`prevUser.content` は原文なので、**逆置換してから比較**する:

```ts
              let rawText = last.content;
              // Find previous user message to strip echo
              const prevIdx = state.messages.length - 2;
              if (prevIdx >= 0) {
                const prevUser = state.messages[prevIdx];
                if (prevUser?.role === "user" && prevUser.content && last.parts) {
                  const rs = replacementSettings();
                  const userText = prevUser.content.trim();
                  const textParts = last.parts.filter((p) => p.type === "text");
                  // Part texts are the raw masked payload — unmask before
                  // comparing against the (original) user echo text.
                  const firstText =
                    textParts.length > 0
                      ? applyReverse(((textParts[0] as any).text ?? ""), rs)
                      : "";
                  if (firstText.trim().startsWith(userText)) {
                    const stripped = firstText.trim().slice(userText.length).trimStart();
                    const restParts = textParts
                      .slice(1)
                      .map((p) => applyReverse((p as any).text ?? "", rs))
                      .join("");
                    rawText = stripped + restParts;
                  }
                }
              }
```

（`last.content` はStep 3で逆置換済みのため、それ以外の分岐は変更不要。`isAzureRefusal` / `tryParseQuestions` / `marked` はこの逆置換済み `rawText` に対してそのまま動く。）

- [ ] **Step 5: question.asked にreverse適用**

`question.asked` ハンドラ（767-790行付近）。質問テキスト類を逆置換:

```ts
          const props = (ev as any).properties ?? {};
          if (props.sessionID && props.sessionID !== _currentSessionId) continue;
          const rs = replacementSettings();
          const questions: PendingQuestion[] = Array.isArray(props.questions)
            ? props.questions
                .map((q: any): PendingQuestion => ({
                  question: applyReverse(String(q?.question ?? ""), rs),
                  header: typeof q?.header === "string" ? applyReverse(q.header, rs) : undefined,
                  options: Array.isArray(q?.options)
                    ? q.options
                        .map((o: any): QuestionOption => {
                          if (typeof o === "string") return { label: applyReverse(o, rs) };
                          return {
                            label: applyReverse(String(o?.label ?? o?.value ?? ""), rs),
                            description:
                              typeof o?.description === "string"
                                ? applyReverse(o.description, rs)
                                : undefined,
                          };
                        })
                        .filter((o: QuestionOption) => o.label)
                    : [],
                  multiple: q?.multiple === true,
                  custom: q?.custom !== false,
                }))
                .filter((q: PendingQuestion) => q.question)
            : [];
```

- [ ] **Step 6: 履歴読込（doLoadSession）にreverse適用**

`doLoadSession`（1469-1485行付近）。サーバー履歴はマスク済みテキストなので、user/assistant両方のテキストを逆置換:

```ts
        const textParts = parts.filter((p: any) => p.type === "text");
        const rs = replacementSettings();
        const textContent = applyReverse(
          textParts.map((p: any) => p.text ?? "").join(""),
          rs,
        );
```

および連結アシスタントメッセージの再計算部（1482-1484行付近）:

```ts
            const prevTextParts = (prev.parts ?? []).filter((p: any) => p.type === "text");
            const prevTextContent = applyReverse(
              prevTextParts.map((p: any) => p.text ?? "").join(""),
              rs,
            );
            prev.content = await marked(prevTextContent);
```

- [ ] **Step 7: 型チェック・全テスト・動作確認**

Run: `npx tsc --noEmit && npm test`
Expected: エラーなし・全テストPASS

アプリで確認（置換有効、ルール例 `株式会社A社→会社X`）:
1. チャットに「株式会社A社について教えて」と送信 → 自分のエコーは原文表示、応答中・応答後も「会社X」ではなく「株式会社A社」と表示される。
2. opencode側のセッションログ（またはLLM応答内容）で、実際に送られたのが「会社X」であること。
3. セッション履歴を読み込み直しても原文表示。

- [ ] **Step 8: コミット**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(replacement): mask opencode chat traffic and unmask responses"
```

---

### Task 9: RAGへの統合（パネルQA＋ブリッジ）

**Files:**
- Modify: `src/features/rag/hooks/useRagFeatures.ts`（`askQuestion`）
- Modify: `src/features/rag/hooks/useRagBridge.ts`（検索結果の返却）

**Interfaces:**
- Consumes: `applyForward` / `applyReverse`（Task 1）、`useSettingsStore.getState().replacement`
- Produces: RAGパネルQAのLLM送信文字列（質問・コンテキスト）がマスクされ、回答が逆置換表示される。opencodeへ返すrag_search結果本文がマスクされる

- [ ] **Step 1: useRagFeatures の askQuestion を変更**

import追加（`useSettingsStore` は既にimport済み）:

```ts
import { applyForward, applyReverse } from "@/shared/lib/replacement";
```

`askQuestion`（218-287行付近）を変更。ポイント: **索引はマスク済みファイル由来が基本状態**なので、検索もマスク済みクエリで行う。コンテキストにもforwardを適用（未マスク索引時の漏れ防止の安全網。マスク済みなら実質no-op）:

```ts
      try {
        const rs = useSettingsStore.getState().replacement;
        // The on-disk files (and thus the index) are masked by the bulk
        // replace, so search with the masked query and send only masked
        // strings to the LLM. The user-visible question stays original.
        const maskedQuestion = applyForward(question, rs);

        await loadEmbed(ragSettings.embeddingModel);
        const queryEmbed = await embed(maskedQuestion, "query");
        const allResults = await invoke<any[]>("rag_search", {
          folderPath,
          embedding: queryEmbed,
          queryText: maskedQuestion,
          limit: ragSettings.retrieveTopK,
          modelName: ragSettings.embeddingModel,
          searchMode: ragSettings.searchMode,
          bm25Weight: ragSettings.bm25Weight,
        });
        // In hybrid mode `score` is an RRF score (different scale from cosine),
        // so the cosine-based minScore threshold only applies to vector mode.
        const results =
          ragSettings.searchMode === "hybrid"
            ? allResults
            : allResults.filter((r: any) => (r.score ?? 0) >= ragSettings.retrieveMinScore);

        // Forward-mask the retrieved context as a safety net for indexes
        // built from unmasked files (no-op when the index is already masked).
        const context = applyForward(
          results
            .map((r: any) => `[${r.file}#${r.heading}]\n${r.text}`)
            .join("\n\n---\n\n"),
          rs,
        );

        const systemPrompt =
          "You are a helpful assistant. Answer the user's question based on the following context from their documents. " +
          "Respond in the same language as the question. Include relevant source references.\n\n" +
          context;

        const answer = applyReverse(await callAI(aiSettings, systemPrompt, maskedQuestion), rs);
```

（以降の `sources` / `marked(answer)` / メッセージ格納は既存のまま。ユーザーメッセージ表示は元々原文 `question` を使用。）

- [ ] **Step 2: useRagBridge の返却結果にforward適用**

`useRagBridge.ts` のimportに追加:

```ts
import { applyForward } from "@/shared/lib/replacement";
```

`work()` 内の結果マップ（137-143行付近）を変更。**`file`（パス）は置換しない** — opencodeのツールがそのパスでファイルを参照するため:

```ts
        // Mask result text before it reaches the LLM via opencode. File
        // paths are NOT masked — opencode tools resolve files by this path.
        const repl = useSettingsStore.getState().replacement;
        return filtered.map((r: any) => ({
          file: r.file,
          heading: applyForward(r.heading ?? "", repl),
          content: applyForward(r.text ?? "", repl),
          line_number: r.line ?? 0,
          score: r.score ?? 0,
        }));
```

（`useSettingsStore` は `useRagBridge.ts` で既にimport済み — 79行付近で使用されている。）

- [ ] **Step 3: 型チェック・全テスト**

Run: `npx tsc --noEmit && npm test`
Expected: エラーなし・全テストPASS

- [ ] **Step 4: 動作確認**

アプリで確認（置換有効・一括置換済みのフォルダ）:
1. RAGパネルで原文の用語（例「株式会社A社」）で質問 → 回答が原文の用語で表示される。
2. opencodeチャットからエージェントに `rag_search` を使わせ、結果がマスク済みで返ること（`[rag-bridge]` コンソールログでも可）。

- [ ] **Step 5: コミット**

```bash
git add src/features/rag/hooks/useRagFeatures.ts src/features/rag/hooks/useRagBridge.ts
git commit -m "feat(replacement): mask RAG QA traffic and bridge results"
```

---

### Task 10: 最終検証

**Files:**
- なし（検証のみ。修正が出た場合は該当ファイル）

- [ ] **Step 1: 全テスト・型チェック・ビルド**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: すべて成功

- [ ] **Step 2: エンドツーエンド確認（verifyスキル相当）**

アプリを起動し、一連のシナリオを通す:
1. 置換パネルでルール作成（またはCSVインポート）→ 有効化。
2. 一括置換 → .mdマスク・タブ更新・RAG再インデックス実行。
3. opencodeチャットで機密用語入り質問 → 表示は原文、送信はマスク。
4. RAGパネルQA → 原文表示。
5. 一括逆置換 → ファイルが原文に戻る。
6. 置換マスタートグルOFF → すべて素通し（従来動作）。

- [ ] **Step 3: 未コミットの修正があればコミットし、完了報告**

```bash
git status
```

Expected: clean（修正が出た場合は `fix(replacement): ...` でコミット）
