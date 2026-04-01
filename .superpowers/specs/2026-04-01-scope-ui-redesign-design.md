# Scope UI Redesign — Design Spec

## Overview

opencode設定画面の全スコープ付きセクション（Rules, Agents, Commands, MCP Servers, Skills, Custom Tools）において、Global/Projectスコープの表示・操作方法を刷新する。

## Goals

1. 一覧時にGlobal/Projectの設定済みアイテムを**統合表示**し、背景色でスコープを区別する
2. 追加/編集時にスコープの選択を**トグルスイッチ**で明示的に行えるようにする
3. 6セクションで共通のスコープUIパターンを**共通コンポーネント/フック**に抽出する

## Current State

- 各セクションが独自に `scope` state + スコープタブ (`oc-section__scope-tabs`) を持つ
- タブ切り替えでGlobal/Projectどちらか一方のみ表示
- 追加時のスコープはタブの選択状態に暗黙的に依存（わかりにくい）

## Design

### 1. 共通コンポーネント/フック

#### `useScopeItems<T>` フック

各セクションのGlobal/Projectアイテムを統合し、Global先・Project後の順で返す。

```ts
type ScopeItem<T> = { scope: "global" | "project"; data: T };

function useScopeItems<T>(
  globalItems: T[],
  projectItems: T[]
): ScopeItem<T>[];
```

#### `ScopeToggle` コンポーネント

追加/編集フォーム用のトグルスイッチ。

```tsx
<ScopeToggle value={scope} onChange={setScope} />
```

- ラベル: "Global"
- ON = Global、OFF = Project
- 既存のチェックボックストグル (`oc-section__toggle`) のスタイルを流用

#### `ScopeFormWrapper` コンポーネント

トグル以下のフォーム入力欄を枠で囲み、スコープに応じて色分け。

```tsx
<ScopeFormWrapper scope={scope}>
  {/* フォーム入力欄 */}
</ScopeFormWrapper>
```

- Global: 紫の枠線 + 紫の背景
- Project: 黄色の枠線 + 黄色の背景

#### CSS変数追加

```css
/* 一覧アイテム・フォーム背景 */
--scope-global-bg: rgba(var(--primary-rgb), 0.25);
--scope-project-bg: rgba(234, 179, 8, 0.15);

/* フォーム枠線 */
--scope-global-border: rgba(var(--primary-rgb), 0.5);
--scope-project-border: rgba(234, 179, 8, 0.5);
```

### 2. 一覧表示の変更

- スコープタブ (`oc-section__scope-tabs`) を**削除**
- Global/Projectの両方を**同時にロード**し、`useScopeItems` で統合
- アイテム表示時にスコープに応じたCSSクラスを付与:

```css
.oc-section__item--global {
  background: var(--scope-global-bg);
}
.oc-section__item--project {
  background: var(--scope-project-bg);
}
```

- 表示順: **Globalアイテムが先、Projectアイテムが後**

### 3. 追加フォームの変更

- フォーム内に `ScopeToggle` を表示
- トグル以下のフォーム入力欄を `ScopeFormWrapper` で囲む
- **デフォルトスコープ**:
  - 通常の追加: **Project**
  - ビルトインアイテムの追加: **Global**
- 保存先ディレクトリ/設定ファイルがトグルに連動

### 4. 編集フォームの変更

- トグル表示（該当スコープが初期値、**変更可能**）
- スコープを変更して保存した場合: **旧スコープから削除 → 新スコープに作成（移動）**

```ts
async function handleSaveWithScopeChange(
  oldScope: Scope, newScope: Scope, name: string, data: T
) {
  if (oldScope !== newScope) {
    await deleteItem(oldScope, name);
  }
  await saveItem(newScope, name, data);
  await reloadAllItems();
}
```

### 5. RulesSection（特殊ケース）

Rulesはアイテム一覧ではなくテキストエディタ。スコープタブを**トグルスイッチに置き換え**、エディタ枠に `ScopeFormWrapper` を適用してスコープ色を表示する。

## Affected Sections

| Section | Storage Type | Global Path | Project Path |
|---------|-------------|-------------|--------------|
| Rules | File | `~/.config/opencode/AGENTS.md` | `./AGENTS.md` |
| Agents | File + Config | `~/.config/opencode/agents/*.md` + `opencode.jsonc` | `.opencode/agents/*.md` |
| Commands | Config | `~/.config/opencode/opencode.jsonc` | `.opencode.jsonc` |
| MCP Servers | Config | `~/.config/opencode/opencode.jsonc` | `.opencode.jsonc` |
| Skills | File | `~/.config/opencode/skills/` | `.opencode/skills/` |
| Custom Tools | File | `~/.config/opencode/tools/` | `.opencode/tools/` |

WebUIセクションはGlobal専用のため対象外。

## Color Summary

| Scope | Item Background | Form Background | Form Border |
|-------|----------------|-----------------|-------------|
| Global | `rgba(primary, 0.25)` | `rgba(primary, 0.25)` | `rgba(primary, 0.5)` |
| Project | `rgba(234, 179, 8, 0.15)` | `rgba(234, 179, 8, 0.15)` | `rgba(234, 179, 8, 0.5)` |
