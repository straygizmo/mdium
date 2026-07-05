# Claude パネル「プラグイン」タブ 設計仕様

- 日付: 2026-07-05
- 対象: mdium の Claude 設定パネルに、opencode 同様の「プラグイン」タブを追加する
- スコープ: **インストール済みプラグインの一覧表示と、有効/無効の切り替えのみ**（インストール/削除・マーケットプレイス管理は対象外）

## 1. 背景・目的

Claude Code の superpowers などのプラグインは、`~/.claude/settings.json` の `enabledPlugins` で有効/無効を切り替えられる。現状 mdium の Claude パネルには MCP・Skills・Rules の管理タブはあるが、プラグインの ON/OFF を GUI で切り替える手段がない。opencode 側にはすでに「プラグイン」タブが存在するため、これに相当するタブを Claude パネルにも追加する。

## 2. データモデル

### 2.1 一覧のソース: `~/.claude/plugins/installed_plugins.json`

```jsonc
{
  "version": 2,
  "plugins": {
    "superpowers@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "C:\\Users\\mtmar\\.claude\\plugins\\cache\\...\\6.1.1",
        "version": "6.1.1",
        "installedAt": "...",
        "lastUpdated": "...",
        "gitCommitSha": "..."
      }
    ]
  }
}
```

- キー = `"<name>@<marketplace>"`。
- 値は install レコードの配列（複数スコープでのインストールを表現）。一覧では先頭（または `scope: "user"`）のレコードから `version` を表示に使う。

### 2.2 有効/無効の状態: `~/.claude/settings.json`

```jsonc
{
  "enabledPlugins": {
    "rust-analyzer-lsp@claude-plugins-official": true,
    "superpowers@claude-plugins-official": true
  }
}
```

- `enabledPlugins` はオブジェクトで、`"<name>@<marketplace>": boolean`。
- **キーが存在しない場合は「有効」とみなす**（インストール済みは既定で有効）。
- Claude はネイティブに `false`（無効）状態を設定ファイルに保持できるため、opencode のような「無効プラグインを別ストアに記録する」仕組みは不要。

### 2.3 一覧の生成

`installed_plugins.json` の `plugins` のキー集合を基準に、各キーについて `settings.json.enabledPlugins[key]` を参照して `enabled` を決定する（未定義なら `true`）。表示項目:

- `name`（`@` の左）
- `marketplace`（`@` の右）
- `version`
- `enabled`（boolean）

## 3. アーキテクチャ / 既存パターンへの追従

フロントは React + TypeScript、Zustand、react-i18next。Claude 設定パネルは `src/features/claude-config/` 配下。

### 3.1 型

`src/shared/types/index.ts` の `ClaudeSettingsTab` に `"plugins"` を追加:

```ts
export type ClaudeSettingsTab = "general" | "rules" | "mcp" | "skills" | "plugins";
```

### 3.2 タブ登録

`src/features/claude-config/components/ClaudeSettings.tsx`:

- `TABS` に `{ key: "plugins", labelKey: "tabPlugins" }` を追加。
- ボディに `tab === "plugins" && <PluginsTab />` を追加。

タブ状態は既存どおり UI ストア（`useUiStore` の `claudeSettingsTab` / `setClaudeSettingsTab`）で管理。既存が文字列ユニオンを受けているため追加の変更は不要（型追加で追従）。

### 3.3 新規コンポーネント

`src/features/claude-config/components/PluginsTab.tsx` を新規作成。既存の `McpServersTab.tsx` と同じ「Rust コマンド経由でファイルを読み書き」パターンに従う。

- マウント時に一覧を読み込む。
- トグル操作で `settings.json` を更新して再読み込み。

### 3.4 データアクセス（Rust 側の新規コマンドは不要）

既存 Tauri コマンドを利用する:

- `get_home_dir` — ホームディレクトリ取得。
- `read_json_file` — `~/.claude/plugins/installed_plugins.json` と `~/.claude/settings.json` の読み込み。
- `write_json_file` — `~/.claude/settings.json` の書き戻し。

書き込み時の注意:

- `settings.json` の**既存の全キーを保持**したまま、`enabledPlugins` のみ差し替える（読み込んだオブジェクトをコピーして該当キーだけ更新）。
- `settings.json` や `enabledPlugins` が存在しない場合は空オブジェクトから生成する。

### 3.5 ロジックの純関数分離（テスト容易化）

副作用（ファイル I/O）とロジックを分離し、以下を純関数として `src/features/claude-config/lib/plugins.ts` などに切り出す:

- `mergePluginList(installed, settings)` → 表示用リスト（name/marketplace/version/enabled）を返す。
- `isPluginEnabled(enabledPlugins, key)` → キー未定義なら `true`。
- `toggleEnabledPlugins(enabledPlugins, key, enabled)` → `enabledPlugins` の新オブジェクトを返す（他キー保持）。

## 4. UI 構成

MCP タブ / opencode プラグインタブと同系統のレイアウト:

- **説明ヘッダ**（i18n）: このタブが `~/.claude/settings.json` の `enabledPlugins` を編集する旨、および CLI では `/plugin` で管理できる旨の補足。
- **リスト**: インストール済みプラグインごとに1行。各行に、名前、`marketplace` バッジ、バージョン、有効/無効チェックボックス。
- **空状態**: インストール済みプラグインが無い場合のメッセージ。
- **反映の注記**: 変更は「新しいチャットセッションから反映される」旨の軽い注記（サイドカーは次回 `claude` 起動時に設定を読むため）。MVP では再起動ボタンは設けない。
- **対象外**: インストール/削除ボタン、マーケットプレイス追加/削除、`+ Add` フォームは設けない。

## 5. 国際化 (i18n)

- 名前空間は **`claude-config`** に統一する（`GeneralSection`/`RulesSection` と揃える。MCP/Skills タブが `settings` 名前空間を使っている点に引きずられない）。
- 追加キー（`src/shared/i18n/locales/en/claude-config.json` と `.../ja/claude-config.json` の両方）例:
  - `tabPlugins`
  - `pluginsDescription`
  - `pluginsEmpty`
  - `pluginEnabled`
  - `pluginMarketplace`
  - `pluginVersion`
  - `pluginApplyNotice`
- UI 文言は一切ハードコードしない（CLAUDE.md 準拠、全て i18n 経由）。

## 6. エラーハンドリング

- `installed_plugins.json` が存在しない/パース不能 → 空リスト扱い（空状態を表示）。エラーは握りつぶさずログ or 非致命的な通知。
- `settings.json` が存在しない → 一覧は全て「有効」表示。トグル時に新規作成。
- 書き込み失敗 → ユーザーにエラー表示（既存の Claude タブのエラー表示パターンに合わせる）、状態は再読み込みで整合を回復。

## 7. テスト

`src/features/claude-config/lib/__tests__/plugins.test.ts`（opencode の `builtin-plugins.test.ts` に倣う）で純関数をユニットテスト:

- `mergePluginList`: installed のキーを基準に列挙し、settings に無いキーは `enabled: true`、`false` のキーは `enabled: false` になる。
- `isPluginEnabled`: 未定義キー → `true`、`false` 明示 → `false`。
- `toggleEnabledPlugins`: 対象キーのみ更新し、他キーは保持。元オブジェクトを破壊しない（イミュータブル）。

## 8. 対象外 (Out of Scope / YAGNI)

- プラグインのインストール/アンインストール（marketplace からの導入、git clone 等）。
- マーケットプレイス（`known_marketplaces.json`）の追加/削除/更新。
- プロジェクト/ローカルスコープ（`.claude/settings.json` / `.claude/settings.local.json`）の編集 — 本 MVP は**ユーザー全体（`~/.claude/settings.json`）のみ**。
- 個別スキル単位の無効化（Claude はプラグイン単位でのみ ON/OFF 可能）。
- 稼働中サイドカーへの即時リロード（`/reload-plugins` 相当）。
