# Claude 設定タブ 書き込み失敗エラー表示の共通化 設計仕様

- 日付: 2026-07-05
- 対象: mdium の Claude 設定パネル各タブで、ファイル書き込み失敗をユーザーに一元的に通知する
- スコープ: `claude-config-store` 経由で書き込む MCP / Skills / Plugins タブ（現状エラー表示が皆無）

## 1. 背景・目的

Claude 設定パネルの MCP・Skills・Plugins タブは、`useClaudeConfigStore` のメソッドを介して `~/.claude.json` や `~/.claude/settings.json`、スキルファイルへ書き込む。しかし現状これらのメソッドは try/catch を持たず、書き込みが失敗（権限不足・ディスクエラー等）してもユーザーへ通知されない。トグルなど await されない呼び出し元では未処理の Promise rejection になる。

一方 RulesSection は既に `invoke` を直接呼び、失敗時にインラインで `saveFailed` を表示している。本仕様では、エラー表示が欠落している store 経由タブに対し、アプリ共通のエラーモーダルによる通知を **store レベルで一元化** する。

## 2. 全体方針

- 書き込み失敗の表示ロジックを **`claude-config-store` に集約**する。
- 表示手段は既存のアプリ共通モーダル **`showMessage(msg, { kind: "error" })`**（`src/stores/dialog-store.ts`）を再利用する。これは SettingsDialog / ReplacementPanel / App など全体で確立済みのパターンで、既にマウント済み。
- store の各書き込みメソッドは失敗時にモーダルを表示し、**エラーを再 throw** する。これにより:
  - 楽観的状態更新（`set({...})`）が失敗時に実行されず、store 状態の不整合を防ぐ。
  - フォーム系の呼び出し元が成功時後処理（フォームを閉じる等）をスキップできる。
- コンポーネントは薄い try/catch を足すだけ（表示は store が担うため、握り潰しでよい）。

## 3. 共有ヘルパー（新規）

新規ファイル `src/stores/claude-config-write-guard.ts` を作成し、`guardWrite` を export（ユニットテスト可能にするため）。

```ts
import { showMessage } from "@/stores/dialog-store";
import i18n from "@/shared/i18n";

// Wrap a write operation so any failure is reported to the user once, via the
// app-wide error modal, and then re-thrown for the caller to react to.
export async function guardWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await showMessage(`${i18n.t("claude-config:saveFailed")}: ${String(e)}`, { kind: "error" });
    throw e;
  }
}
```

- `showMessage` の import 元: `src/stores/dialog-store.ts`（名前付きエクスポート。確認済み）。
- i18n の共有インスタンス import 元: `src/shared/i18n`（`export default i18n` のデフォルトエクスポート。確認済み）。よって `import i18n from "@/shared/i18n"` とする。
- メッセージは既存 i18n キー **`saveFailed`**（`claude-config` 名前空間、"Save failed" / "保存に失敗しました"）を再利用し、`: <エラー詳細>` を付与する。**新規 i18n キーは追加しない**。
- 名前空間指定は `i18n.t("claude-config:saveFailed")` の形式で行う（呼び出し元コンポーネントの名前空間に依存しない）。

## 4. store 側の変更（`src/stores/claude-config-store.ts`）

以下 11 個の書き込みメソッドの**本体を `guardWrite(async () => { ... })` で包む**:

| メソッド | 書き込み |
|---|---|
| `setClaudePluginEnabled` | `write_json_file`（settings.json） |
| `saveGlobalMcpServer` | `writeMcpToFile` |
| `deleteGlobalMcpServer` | `writeMcpToFile` |
| `toggleGlobalMcpServer` | `writeMcpToFile` |
| `saveProjectMcpServer` | `writeMcpToFile` |
| `deleteProjectMcpServer` | `writeMcpToFile` |
| `toggleProjectMcpServer` | `writeMcpToFile` |
| `saveGlobalSkill` | `write_skill` |
| `deleteGlobalSkill` | `delete_skill` |
| `saveProjectSkill` | `write_skill` |
| `deleteProjectSkill` | `delete_skill` |

制約:

- **二重通知の防止**: 下位の共通ライタ `writeMcpToFile`（6 個の MCP メソッドが共有）には catch を入れない。通知はメソッド層の `guardWrite` に一本化する。
- 各メソッドの `guardWrite` で包む範囲は、読み込み・計算・書き込み・`set` を含む本体全体とする。失敗時は `set` に到達せず再 throw される。
- `loadClaudePlugins` / `loadGlobalMcp` などの読み込み専用メソッドは対象外（書き込み失敗の通知が目的のため）。

## 5. コンポーネント側の変更（薄いガードのみ）

store が「表示 + 再 throw」する前提で、成功後処理のスキップと未処理 rejection の防止のみ行う。**エラーメッセージの表示コードはコンポーネントに書かない**（store 集約）。

### McpServersTab.tsx
- `handleSave`: `await saveGlobalMcpServer(...)` を try/catch。失敗時は `return`（`setEditing(null)` / `setAdding(false)` を実行しない）。
- `handleDelete`: `await deleteGlobalMcpServer(...)` を try/catch（失敗時は握り潰し）。
- toggle: `onClick={() => toggleGlobalMcpServer(name)}` を async ハンドラ化し try/catch で握り潰す。

パターン例:
```ts
const handleSave = async (name: string, server: McpServer) => {
  try {
    await saveGlobalMcpServer(name, server);
  } catch {
    return; // store already reported the error
  }
  setEditing(null);
  setAdding(false);
};
```

### SkillsTab.tsx
- `handleSave` / `handleDelete`: 同様に try/catch。失敗時は成功後処理をスキップ/握り潰し。

### PluginsTab.tsx
- toggle: `onChange` を async ハンドラ化し、`setClaudePluginEnabled(...)` を try/catch で握り潰す（store が通知済み）。

## 6. 対象外 (Out of Scope)

- **RulesSection.tsx**: store を経由せず `invoke("write_text_file_with_dirs")` を直接呼び、既にインラインで `saveFailed` を表示済み（明示 Save ボタンの成功「Saved」表示とセットの UX）。**変更しない**。
- **GeneralSection.tsx**: ファイル書き込みなし（`useClaudeSessionStore` のセッション状態のみ）→ 対象外。
- 新しいトースト基盤の導入や `useToast` のマウントは行わない（YAGNI）。
- 成功時のトースト表示は追加しない（本仕様は失敗通知のみ）。

## 7. エラーハンドリングの整合

- 二重通知なし（メソッド層のみで表示）。
- 再 throw により、フォーム系はフォームを閉じず、トグル系は握り潰しで UI が実状態に戻る（トグルメソッドは失敗時 `set` 未実行 → 次回 `loadX` や既存 state のまま）。
- `showMessage` は Promise を返すモーダル。await するが、ユーザー操作をブロックするのは失敗時のみで許容範囲。

## 8. テスト

新規 `src/stores/__tests__/claude-config-write-guard.test.ts` で `guardWrite` を検証（`@/stores/dialog-store` と `@/shared/i18n` を Vitest でモック）:

- **成功時**: `fn` が解決する値をそのまま返し、`showMessage` を呼ばない。
- **失敗時**: `fn` が reject すると、`showMessage` が `{ kind: "error" }` で 1 回呼ばれ、かつ元のエラーが再 throw される（`await expect(...).rejects.toBe(originalError)`）。

store メソッド個々のユニットテストは追加しない（共有の `guardWrite` が唯一の分岐点であり、そこを検証すれば全メソッドの挙動を担保できるため）。
