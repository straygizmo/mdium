# opencode 設定タブ「プラグイン」セクション + ビルトインプラグイン化 — 設計仕様

- 作成日: 2026-06-05
- 対象: mdium（Tauri アプリ）の opencode 連携
- ステータス: 設計承認済み（実装プラン作成前）

## 1. 目的 / ゴール

opencode 設定タブに新しく「プラグイン」セクションを追加し、以下を実現する。

1. opencode の `opencode.jsonc` の `plugin` 配列（パッケージ仕様の文字列配列）を GUI で管理できるようにする。
2. **superpowers** と **oh-my-opencode** を「ビルトインプラグイン」としてカタログ表示し、トグル ON/OFF で有効化/無効化できるようにする。
3. ユーザーが任意のプラグイン仕様（npm 名 / git URL / ローカルパス）をカスタム追加・削除できるようにする。

## 2. 確定した方針（ブレインストーミングでの決定事項）

| 論点 | 決定 |
|---|---|
| インストール元の戦略 | **ネットワーク自動取得**。`plugin` 配列に git URL / npm 名を書き、opencode が起動時に Bun で取得する。mdium 側でのローカル vendor は行わない。 |
| セクションの機能範囲 | **ビルトイン + カスタム追加**。ビルトイン2件をトグルで ON/OFF、加えて任意の plugin エントリを追加・削除できる。 |
| 書き込み先スコープ | **グローバルのみ**（`~/.config/opencode/opencode.jsonc` の `plugin` 配列）。プロジェクトスコープ切替は行わない。 |
| ビルトインの初期状態 | **既定 OFF（オプトイン）**。セクションにカタログ表示されるが、ユーザーがトグルで有効化するまで `plugin` 配列には追加しない。 |

## 3. 背景（opencode のプラグイン機構）

- opencode のプラグインは `opencode.json(c)` の `plugin` 配列に列挙する。各要素はパッケージ仕様の文字列：
  - npm 名: `"oh-my-openagent"`
  - git URL: `"superpowers@git+https://github.com/obra/superpowers.git"`（`#v5.1.0` 等でタグ/ブランチ固定可）
  - ローカルパス
- opencode は起動時に Bun でこれらを自動インストールし、`~/.cache/opencode/node_modules/` にキャッシュする。
- **プラグインはサーバ起動時にロードされる**ため、`plugin` 配列の変更を反映するには opencode サーバの再起動が必要。

### 既存コードベースの該当パターン

- 設定タブ本体: `src/features/opencode-config/components/OpencodeConfigPanel.tsx`
  - `TABS` 配列でタブ定義、`TAB_SECTIONS` で各セクションをマップ。
- ビルトインレジストリ: `src/features/opencode-config/lib/builtin-registry.ts`
  - `BUILTIN_MCP` / `BUILTIN_SKILLS` などのカタログ + `getMissingBuiltin*` / `isBuiltin*` ヘルパー。
- セクション実装の代表例: `src/features/opencode-config/components/sections/McpServersSection.tsx`
  - 一覧表示 + トグル + 追加フォーム + `Built-in` バッジ + ドキュメントリンクの作法。
- 設定ストア: `src/stores/opencode-config-store.ts`
  - `readConfig` / `writeConfig`（グローバル `opencode.jsonc` 全体を読み書き、対象フィールドのみ更新、他は保持）。`writeConfig` は `JSON.stringify(config, null, 2)` でコメントは除去される（全セクション共通の既存挙動）。
- サーバ管理: `src/stores/opencode-server-store.ts`
  - `removeServer(folderPath)` でプロセス kill。再接続は既存のチャット接続フロー（`useOpencodeChat.ts`）を再利用。
- 型: `src/shared/types/index.ts` の `OpencodeConfig` / `OpencodeConfigTab`。
- i18n: `src/shared/i18n/locales/{ja,en}/opencode-config.json`。

## 4. データモデル

### 4.1 OpencodeConfig 型の拡張

`src/shared/types/index.ts` の `OpencodeConfig` に opencode ネイティブのフィールドを追加：

```typescript
export interface OpencodeConfig {
  // ...既存...
  plugin?: string[];   // opencode 公式の plugin 配列（パッケージ仕様の文字列）
}
```

`OpencodeConfigTab` に `"plugins"` を追加：

```typescript
export type OpencodeConfigTab =
  "rules" | "tools" | "agents" | "commands" | "mcp" | "skills" | "custom-tools" | "webui" | "plugins";
```

### 4.2 ビルトインプラグインのカタログ

新規ファイル `src/features/opencode-config/lib/builtin-plugins.ts`：

```typescript
export interface BuiltinPluginEntry {
  /** plugin 配列に書き込む正規の仕様文字列（npm名 / git URL / ローカルパス） */
  spec: string;
  /** UI 表示用の説明（i18n キー参照でも、直接日英を持たせてもよい） */
  description: string;
  /** ドキュメント URL（🔗 リンク先） */
  docsUrl: string;
}

export const BUILTIN_PLUGINS: Record<string, BuiltinPluginEntry> = {
  superpowers: {
    spec: "superpowers@git+https://github.com/obra/superpowers.git#v5.1.0", // タグ固定で再現性確保
    description: "...",
    docsUrl: "https://github.com/obra/superpowers/blob/main/docs/README.opencode.md",
  },
  "oh-my-opencode": {
    spec: "oh-my-openagent", // ※正確なパッケージ名は実装時に npm で確定する
    description: "...",
    docsUrl: "https://ohmyopencode.com/",
  },
};
```

### 4.3 ビルトインレジストリのヘルパー（builtin-registry.ts へ追加）

他の `getMissingBuiltin*` / `isBuiltin*` と同形で追加：

```typescript
export { BUILTIN_PLUGINS } from "./builtin-plugins";

/** plugin 配列に未登録のビルトインプラグイン id を返す */
export function getMissingBuiltinPlugins(currentPlugins: string[]): string[] {
  const present = new Set(currentPlugins);
  return Object.keys(BUILTIN_PLUGINS).filter((id) => !present.has(BUILTIN_PLUGINS[id].spec));
}

/** 与えられた spec 文字列がビルトインプラグインのものか判定 */
export function isBuiltinPlugin(spec: string): boolean {
  return Object.values(BUILTIN_PLUGINS).some((e) => e.spec === spec);
}
```

### 4.4 「有効」の定義

- ビルトインプラグインが「有効」⇔ その `spec` 文字列が `config.plugin` 配列に**完全一致で**存在する。
- トグル ON: `addPlugin(spec)`、OFF: `removePlugin(spec)`。
- カスタムプラグイン: `config.plugin` 配列のうち、どのビルトイン `spec` にも一致しないエントリ。
- マッチングは spec 完全一致のみ（ビルトインの正規 spec は mdium が管理するため十分）。ユーザーが手動で別バージョンを書いた場合はカスタム扱いになる（許容）。

## 5. ストアの拡張（opencode-config-store.ts）

グローバル `opencode.jsonc` のみを対象に2メソッドを追加。

```typescript
// インターフェース
addPlugin: (spec: string) => Promise<void>;
removePlugin: (spec: string) => Promise<void>;
```

実装（既存 `readConfig`/`writeConfig` 利用、重複排除）：

```typescript
addPlugin: async (spec) => {
  const fresh = await readConfig();
  const list = fresh.plugin ?? [];
  if (!list.includes(spec)) list.push(spec);
  fresh.plugin = list;
  await writeConfig(fresh);
  set({ config: fresh });
},

removePlugin: async (spec) => {
  const fresh = await readConfig();
  fresh.plugin = (fresh.plugin ?? []).filter((p) => p !== spec);
  await writeConfig(fresh);
  set({ config: fresh });
},
```

## 6. UI セクション（PluginsSection.tsx 新規）

配置: `src/features/opencode-config/components/sections/PluginsSection.tsx`。
`McpServersSection.tsx` の作法（`oc-section__*` クラス、`open_external_url` リンク、`Built-in` バッジ、追加フォーム）を踏襲。

構成要素：

1. **説明文 + ドキュメントリンク**: 先頭に `oc-section__hint` で説明 + opencode plugins ドキュメントへの 🔗 リンク（`invoke("open_external_url", { url: t("pluginsDocsUrl") })`）。
2. **ビルトインプラグイン一覧**: `BUILTIN_PLUGINS` を列挙。各行に
   - 名前 + `Built-in` バッジ + 各プラグインの `docsUrl` への 🔗 リンク
   - 説明文
   - 右側に ON/OFF トグル（`config.plugin` に spec が含まれるかで checked を決定）。変更時に `addPlugin`/`removePlugin` を呼ぶ。
3. **カスタムプラグイン一覧**: `config.plugin` のうち `isBuiltinPlugin` で false のエントリを spec 文字列で表示。各行に削除（×）ボタン（`removePlugin` + `pluginDeleteConfirm` 確認）。
4. **「+ 追加」**: spec 文字列（npm 名 / git URL / ローカルパス）を入力する単一テキスト入力フォーム。保存で `addPlugin`。
5. **再起動の注意 + 再起動ボタン**:
   - 注意文（i18n `pluginRestartNotice`）でサーバ再起動が必要な旨を明示。
   - 「再起動」ボタンでアクティブフォルダの opencode サーバを `useOpencodeServerStore.removeServer(activeFolderPath)` → 既存接続フローで再接続させ、`plugin` 変更を反映する。再接続トリガの正確な呼び出しは `useOpencodeChat.ts` の接続ロジックを再利用（実装プランで詳細化）。
6. **スコープ**: グローバル固定のため `ScopeToggle` は使わない。保存先 `~/.config/opencode/opencode.jsonc` を `oc-section__path-hint` 等で表示。

## 7. タブ配線

`OpencodeConfigPanel.tsx`:

- `import { PluginsSection } from "./sections/PluginsSection";`
- `TABS` 配列に `{ key: "plugins", labelKey: "tabPlugins" }` を追加（MCP の近辺）。
- `TAB_SECTIONS` に `plugins: <PluginsSection />` を追加。

`OpencodeConfigBadges.tsx` / `ui-store.ts` の `opencodeConfigTab` 関連は型追加（`"plugins"`）に追従。型を増やすことで網羅性チェックが効くため、コンパイルエラー箇所を潰す形で対応。

## 8. i18n（ja / en 両方に追加）

UI 文字列ハードコード禁止のため、以下キーを `opencode-config.json`（ja・en）に追加：

- `tabPlugins` — タブ名「プラグイン」/「Plugins」
- `pluginsDescription` — セクション説明
- `pluginsDocsUrl` — opencode plugins ドキュメント URL
- `pluginsEmpty` — カスタムプラグインが無いときの表示
- `pluginsBuiltinTitle` — ビルトイン一覧の見出し
- `pluginsCustomTitle` — カスタム一覧の見出し
- `pluginAdd` — 追加ボタン/フォームラベル
- `pluginSpec` — spec 入力フィールドのラベル
- `pluginSpecPlaceholder` — 入力プレースホルダ（例示）
- `pluginDeleteConfirm` — 削除確認（`{{name}}`）
- `pluginRestartNotice` — 再起動が必要な旨の注意文
- `pluginRestart` — 再起動ボタン
- `pluginRestarting` — 再起動中表示
- （必要なら）各ビルトインの説明 `pluginDesc_superpowers` / `pluginDesc_oh-my-opencode`

## 9. 留意点 / リスク

- opencode は初回有効化時に Bun でネットワーク取得するため、**再起動後の初回接続が遅くなる**、また**プロキシ/閉域環境では取得が失敗し得る**。ネットワーク取得方式を選択済みのため許容。UI 上は再起動後の接続状態（既存の接続インジケータ）で確認する。
- ビルトインの spec はバージョン固定（superpowers はタグ）で再現性を確保する。
- **oh-my-opencode の正確なパッケージ名は実装時に npm で確定**する（`oh-my-openagent` / `oh-my-opencode` 等の候補あり）。レジストリの1行差し替えで対応可能。
- `writeConfig` は JSONC のコメントを除去する（全セクション共通の既存挙動、本機能でも同様）。

## 10. 受け入れ条件

1. opencode 設定タブに「プラグイン」タブが表示される。
2. superpowers / oh-my-opencode がビルトインとしてカタログ表示され、初期状態は OFF。
3. トグル ON で該当 spec が `~/.config/opencode/opencode.jsonc` の `plugin` 配列に追加され、OFF で削除される。
4. 任意の spec 文字列をカスタム追加・削除できる。
5. 再起動操作でアクティブフォルダの opencode サーバが再起動され、`plugin` 変更が反映される（プラグインのスキル/機能が利用可能になる）。
6. すべての UI 文字列が i18n（ja/en）経由で、ハードコードが無い。
7. 既存タブ・既存設定（rules/agents/mcp 等）に regression が無い。

## 11. スコープ外（YAGNI）

- プロジェクトスコープでの plugin 管理。
- ローカル vendor / オフラインフォールバック。
- プラグインのバージョン選択 UI（固定 spec のみ）。
- インストール進捗の詳細表示（接続インジケータで代替）。
