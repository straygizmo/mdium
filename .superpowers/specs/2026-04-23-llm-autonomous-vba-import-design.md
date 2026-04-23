# LLM 自律的 VBA マクロ取り込み 設計仕様

## 概要

MDium 内の opencode チャットから起動された LLM が、`.xlsm` / `.xlam` の VBA マクロを編集した後に、MDium の既存機能「マクロを取り込み」を **LLM 自身の意思で自律的に呼び出せる** ようにする。

具体的には、MDium バンドルの新規 MCP サーバー `mdium-vba` を介して、LLM が extract / import ツールを呼び出し可能にする。チャットは 1 つの xlsm ファイルに紐づけられ、対象ファイルの取り違えを二重の防御層（メッセージラップ＋ツール応答検証）で防ぐ。

### 目的

- LLM に「extract → 編集 → import」を 1 ターンで自走させ、ユーザーのボタン操作を不要にする
- 複数ファイル/複数チャットが混在しても、誤ったファイルへ書き込みが起きない設計にする
- 既存の VBA 機能（extract_vba_modules / inject_vba_modules）を再利用し、ロジック重複を避ける

### スコープ外 (Phase 2 で別 spec 化)

- VBA マクロ実行 (`run_vba_macro`) と結果取得
- Excel COM 自動化
- サンドボックスコピーでの実行

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│ MDium (Tauri)                                       │
│                                                     │
│  PreviewPanel (.xlsm / .xlam アクティブ時)          │
│   ├─ [マクロのエクスポート] ボタン (既存)           │
│   ├─ [マクロのインポート] ボタン (既存)             │
│   └─ [LLM 自動取り込みを許可] トグル (新規)         │
│                                                     │
│  useOpencodeChat                                    │
│   ├─ 送信メッセージを <mdium_context> で自動ラップ  │ ← L1
│   └─ トグル ON で opencode 設定に mdium-vba を登録  │
│     (port/token は起動毎に更新)                     │
│                                                     │
│  ローカル HTTP bridge                               │
│   (127.0.0.1:random, bearer token auth)             │
│   ├─ POST /vba/list                                 │
│   ├─ POST /vba/extract                              │
│   ├─ POST /vba/inject                               │
│   └─ GET  /active-xlsm                              │
│   → 既存 extract_vba_modules / inject_vba_modules   │
│                                                     │
│  Active xlsm state (Arc<Mutex<Option<PathBuf>>>)    │
│   PreviewPanel がアクティブタブ変更時に更新         │
│                                                     │
└──────────────────────┬──────────────────────────────┘
                       │ opencode が env で spawn:
                       │   MDIUM_VBA_PORT, MDIUM_VBA_TOKEN
┌──────────────────────▼──────────────────────────────┐
│ mdium-vba MCP Server                                │
│ (Node.js, resources/mcp-servers/mdium-vba/)         │
│                                                     │
│  Tools:                                             │
│   - list_vba_modules                                │
│   - extract_vba_modules                             │
│   - import_vba_macros                               │
│                                                     │
│  各ツール呼び出し時に GET /active-xlsm でアクティブ │
│  xlsm を動的取得 → /vba/* を呼ぶ                    │
│  応答には activeFile を常時同梱  ← L2               │
└─────────────────────────────────────────────────────┘
```

---

## コンポーネント詳細

### 1. MCP サーバー (`resources/mcp-servers/mdium-vba/`)

新規 Node.js パッケージ。既存 `nano-banana-2` と同じバンドル方式。

**責務:**
- stdio で MCP プロトコルを話す（`@modelcontextprotocol/sdk` 使用）
- 起動時 env var から `port`, `token` を読み取る
- 各ツール呼び出しの瞬間に `GET /active-xlsm` で現在のアクティブ xlsm を取得
- `/vba/*` エンドポイントに中継
- 応答に `activeFile` を常時同梱

**ファイル構成:**
```
resources/mcp-servers/mdium-vba/
  package.json
  src/index.ts      # MCP サーバーエントリポイント
  src/http-client.ts # MDium HTTP bridge クライアント (fetch ラッパ)
```

**起動時の env var（必須）:**
- `MDIUM_VBA_PORT` — MDium ローカル HTTP bridge のポート番号
- `MDIUM_VBA_TOKEN` — bearer token（MDium 起動時にランダム生成。MDium 再起動のたびに変わる）

**設計方針（Active-Tab-Dynamic）:**
opencode は MCP サーバーを自身の config に基づいて spawn するため、MDium が「このチャット用だけ xlsm を固定」と per-chat で env var 注入することはできない。代わりに、MCP サーバーは **ツール呼び出しの瞬間にアクティブタブを MDium に問い合わせる**。これにより:
- チャット寿命中もアクティブタブ切替に追随する
- LLM の誤認防止は L1（メッセージ先頭 `<mdium_context>`）+ L2（ツール応答の `activeFile`）に依存
- MDium 起動のたびに port/token が変わるため、トグル ON 状態でアプリ起動するたびに opencode config を書き換える必要がある

### 2. ローカル HTTP bridge (`src-tauri/src/http_bridge.rs`)

MDium 起動時に 1 度だけ loopback で listen する軽量 HTTP サーバー（`axum` or `tiny_http` などを使用）。

**責務:**
- `127.0.0.1` のみバインド（外部アクセス拒否）
- `Authorization: Bearer <token>` ヘッダの検証
- トークンはアプリ起動時に 1 つ生成し、プロセス内で保持
- 各 MCP サーバー起動時にそのトークンを env var で渡す
- エンドポイントの実装は既存 Tauri コマンド（`extract_vba_modules` / `inject_vba_modules`）を内部で呼び出すだけ

**エンドポイント:**

| メソッド | パス | リクエスト | レスポンス |
|---|---|---|---|
| GET  | `/active-xlsm` | なし | `{path: string \| null}` |
| POST | `/vba/list` | `{xlsm_path}` | `{activeFile, macrosDir, exists, modules[]}` |
| POST | `/vba/extract` | `{xlsm_path}` | `{activeFile, macrosDir, modules[]}` |
| POST | `/vba/inject` | `{xlsm_path, macros_dir}` | 成功時: `{activeFile, backupPath, updatedModules}` / モジュール構成変更時: `409 {error, activeFile, newInFiles, missingInFiles, message}` |

すべてのレスポンスに `activeFile` (= MDium が現時点で保持するアクティブタブのパス) を含める。MCP サーバーは `GET /active-xlsm` で取得したパスをそのまま `xlsm_path` として送るため、通常 `activeFile === 送信した xlsm_path`。差異がある場合のみ `active_tab_changed` エラー。

**アクティブタブ変化検出:**
MCP サーバーが `GET /active-xlsm` でパスを取得 → `POST /vba/*` で送信するまでの間にアクティブタブが変わっていたら、HTTP bridge は 409 を返す:
```json
{
  "error": "active_tab_changed",
  "sentPath": "...",
  "activeFile": "...",
  "message": "Active tab changed between resolution and operation. Retry."
}
```
通常 LLM ツール 1 回呼び出しで 2 回 HTTP コールになるが、その間の race window は極小（ミリ秒オーダー）。発生時は retry 推奨。

### 3. Tauri コマンド / 状態管理

**新規 Tauri コマンド:**
- `set_allow_llm_vba_import(enabled: bool)` — グローバルトグル更新
- `get_allow_llm_vba_import() -> bool` — トグル状態取得
- `get_active_xlsm_path() -> Option<String>` — アクティブタブの xlsm パス取得（HTTP bridge 内でも使用）

**設定ストア:**
既存の app settings に `allowLlmVbaImport: boolean` フィールドを追加。デフォルト `false`。

### 4. PreviewPanel.tsx の変更

`.xlsm` / `.xlam` が active の時、既存の convert-bar に新トグル:

```tsx
{isMacroEnabled && (
  <label className="preview-panel__toggle">
    <input
      type="checkbox"
      checked={allowLlmImport}
      onChange={(e) => handleToggleAllowLlm(e.target.checked)}
    />
    {t("allowLlmVbaImport")}
  </label>
)}
```

インポート成功時（ボタン or MCP 経由）、MDium が `binaryData` を再読込してプレビューを更新し、トーストで通知する処理は共通化する。

### 5. useOpencodeChat.ts の変更

**送信メッセージの自動ラップ (L1):**
```typescript
const wrapWithContext = (userMessage: string): string => {
  const activeTab = useTabStore.getState().getActiveTab();
  if (!activeTab?.filePath) return userMessage;
  return `<mdium_context>
active_file="${activeTab.filePath}"
</mdium_context>

${userMessage}`;
};
```

送信時にすべてのユーザーメッセージをラップ。LLM は毎ターン現在のアクティブファイルを確認できる。

**MCP サーバー起動時の env var 注入:**
opencode 起動時の MCP サーバー設定において、`mdium-vba` を以下の条件でマージ:

1. `allowLlmVbaImport` トグルが ON
2. チャット起動時のアクティブタブが `.xlsm` / `.xlam`

条件を満たす場合、opencode MCP 設定に以下を追加:

```json
{
  "mdium-vba": {
    "command": "node",
    "args": ["<resolved>/mcp-servers/mdium-vba/index.js"],
    "env": {
      "MDIUM_VBA_XLSM": "<active xlsm abs path>",
      "MDIUM_VBA_PORT": "<local bridge port>",
      "MDIUM_VBA_TOKEN": "<session token>"
    }
  }
}
```

### 6. MCP ツール契約（全て引数なし）

#### `list_vba_modules`

**引数:** なし
**戻り値:**
```typescript
{
  activeFile: string,       // ツール呼び出し時点でのアクティブタブ xlsm 絶対パス
  macrosDir: string,        // {stem}_macros ディレクトリのパス
  exists: boolean,          // _macros/ が既に存在するか
  modules: Array<{
    name: string,
    moduleType: "standard" | "class" | "document",
    path: string            // ファイルパス (exists: true のとき)
  }>
}
```
**用途:** LLM が extract 済みかどうかを事前確認するのに使う。

**新規 Tauri コマンド:** 現状 `list_vba_modules` は存在しないので新規追加。実装は `extract_vba_modules` の前半（ZIP 展開 → dir stream パース）だけを行い、ファイル書き出しはせず、`_macros/` の存在チェックと合わせて返す。ファイル書き出しを伴わない軽量な読み取りのみ。

#### `extract_vba_modules`

**引数:** なし
**戻り値:**
```typescript
{
  activeFile: string,
  macrosDir: string,
  modules: Array<{ name, moduleType, path }>
}
```
**挙動:** 既存の Tauri コマンドを呼ぶ。`_macros/` が既にあれば既存ファイルを上書き（新規モジュールは追加、削除はしない。既存仕様踏襲）。

#### `import_vba_macros`

**引数:** なし

**成功時の戻り値:**
```typescript
{
  activeFile: string,
  backupPath: string,       // .xlsm.bak の絶対パス
  updatedModules: string[]  // 中身を差し替えたモジュール名
}
```

**モジュール構成変更検出時（＝失敗）:**
```typescript
{
  error: "module_set_changed",
  activeFile: string,
  newInFiles: string[],     // _macros/ に存在するが vbaProject.bin に対応モジュールが無いファイル
  missingInFiles: string[], // vbaProject.bin に存在するが _macros/ に対応ファイルが無いモジュール
  message: string
}
```

**挙動:** 既存 `inject_vba_modules` を呼ぶ。成功後、MDium が自動で:
- プレビューパネルの `binaryData` を再読込
- `macroImportSuccess` トーストを表示

**既存コードの挙動変更（重要）:**
現状の `inject_vba_modules` は名前不一致のモジュールを黙ってスキップする。本 spec では、**インポート実行前に `_macros/` 内ファイル集合と `vbaProject.bin` 内モジュール集合の差分を検出し、差があれば xlsm に一切書き込まず即エラー返却** する「strict モード」に変更する。UI ボタン経由のインポートも同じ挙動になる（silent 失敗による事故防止。詳細は後述の「モジュール追加/削除/リネームの扱い」節）。

`InjectResult` は成功時のみ返す構造のまま（`backup_path`, `updated_modules`）。モジュール構成変更時はエラー型として `ModuleSetChanged { new_in_files, missing_in_files }` を返す。Tauri コマンドの戻り値はいずれかの variant を持つ enum にするか、既存の `Result<InjectResult, String>` のまま `String` に JSON 化したエラー詳細を入れるかは実装判断（後者が既存 UI との互換性が高い）。

---

## モジュール追加/削除/リネームの扱い

**Phase 1 の方針: 検出して拒否（strict モード）。**

### 背景
現状の `inject_vba_modules` は「既存モジュールの中身差し替え」のみに対応し、以下は silent に失敗する:
- `_macros/` に新規 `.bas`/`.cls` を作っても xlsm に追加されない
- `_macros/` から `.bas`/`.cls` を削除しても xlsm のモジュールは残る
- リネームは「旧モジュールは残り、新ファイルは追加されない」で二重に壊れる

元 spec (`2026-03-30-excel-macro-export-import`) でも「新規モジュールの追加は対象外（既存モジュールの差し替えのみ）」と明記。VBA プロジェクトへのモジュール追加/削除は `dir` ストリームの書き換え + `PROJECTMODULES` カウント更新 + OLE2 ストリーム追加/削除を要し、Phase 1 のスコープを大きく超える。

### 検出ロジック
`inject_vba_modules` が本処理に入る前に:

1. `_macros/` 内の `.bas`/`.cls` ファイル名集合 → `F`（ドットベース名のみ、`.codepage` は除外）
2. `vbaProject.bin` 内のモジュール名集合 → `M`
3. `newInFiles = F - M`（追加しようとしている新規モジュール名）
4. `missingInFiles = M - F`（削除しようとしているモジュール名）
5. 両方空なら通常の置き換え処理へ進む
6. どちらかが非空なら **xlsm への書き込みを一切行わず、`.bak` も作らず** エラー応答

### エラー応答
```json
{
  "error": "module_set_changed",
  "newInFiles": ["Module1b", "Helpers"],
  "missingInFiles": ["Module3"],
  "message": "Adding or removing modules is not supported. Revert the additions/deletions, or ask the user to add/remove modules in Excel's VBE first, then re-run extract_vba_modules."
}
```

### UI ボタン経由での挙動
既存 UI の「マクロのインポート」ボタンも同じ strict 検査を通る。差分がある場合、`macroModuleSetChanged` 新 i18n キーで以下のエラーを表示:

| ja | en |
|---|---|
| モジュール構成が変更されています: 追加 {{new}}, 削除 {{missing}}。Excel の VBE で手動追加/削除後、再エクスポートしてください。 | Module set changed: added {{new}}, removed {{missing}}. Add/remove modules in Excel's VBE first, then re-export. |

### Phase 2+ での拡張余地
モジュール追加/削除をサポートする場合、別コマンド（例: `inject_vba_modules_with_schema`）として分離する。`dir` ストリーム書き換えと `PROJECTMODULES` カウント更新、OLE2 ストリーム追加/削除の実装が必要。

---

## スキル連携 (vba-coding-conventions)

既存ビルトインスキル `vba-coding-conventions` の末尾に **「MDium マクロ編集フロー」セクション** を追加。

**条件付き混入:**
`allowLlmVbaImport` トグルが ON の時のみ、このセクションをスキル内容に含める。OFF の場合は従来通り（ツールが無いのにフローを書いても意味がないため）。

**追加セクション骨子:**

```markdown
## MDium マクロ編集フロー

このセッションでは MDium の `mdium-vba` MCP サーバーが利用可能です。

### 標準フロー

1. `list_vba_modules` で既存の _macros/ 状態を確認
2. `_macros/` が存在しなければ `extract_vba_modules` を呼ぶ
3. Read/Edit ツールで `.bas` / `.cls` を編集
4. **編集が完了したら必ず `import_vba_macros` を呼ぶ**
5. 応答の `updatedModules` をユーザーに報告

### 重要な制約

- このツールは **ツール呼び出しの瞬間のアクティブタブ** に対して動作します
- 毎回のユーザーメッセージ先頭に `<mdium_context>active_file="..."</mdium_context>` が埋め込まれます
- ツール応答の `activeFile` と、直前のユーザーメッセージの `active_file` が一致することを必ず確認してください
- もしユーザーが会話中にタブを切り替えたら、`<mdium_context>` の `active_file` が変わります。ユーザーの意図を確認せずに新しいファイルを編集しないでください（「タブが {old} から {new} に変わりましたが、このまま続けますか？」と質問する）
- `error: "active_tab_changed"` が返った場合は race condition なので 1 回だけ retry してください（それでも失敗したら停止）

### モジュール構成を変えてはいけない

**`.bas` / `.cls` ファイルの新規作成・削除・リネームはしないでください。** MDium の取り込みは**既存モジュールの中身差し替えのみ**サポートします。

- 新規モジュールを作りたい：ユーザーに Excel の VBE で手動追加してもらい、再度 `extract_vba_modules` を呼んで取得
- モジュールを削除したい：ユーザーに Excel の VBE で手動削除してもらう
- リネームしたい：同様にユーザーに VBE で行ってもらう

`import_vba_macros` が `error: "module_set_changed"` を返した場合、`newInFiles` と `missingInFiles` の内容を見て、どちらの変更を戻すべきかをユーザーに確認してください。
```

### 多重防御の振る舞い

| 層 | 検出対象 | 作用 |
|---|---|---|
| L1 メッセージラップ | ユーザーが何を見ているか | `<mdium_context>` で毎ターン LLM に通知 |
| L2 ツール応答の activeFile | 実際にどのファイルに作用したか | LLM が L1 の active_file と照合 |
| L3 スキルのガイド | LLM の規律 | タブ切替検出時の質問フレーズを規定 |

**前版からの変更点**: opencode の MCP spawn アーキテクチャ上、env var による「チャットセッション bind」は実装困難と判明したため、active-tab-dynamic 方式に変更。ガードは「HTTP 層での拒否 (以前の L2)」から「LLM 側での認識整合 (L1+L2 をスキルで促す)」に重心移動。race condition のみ HTTP 層で `active_tab_changed` として 409 を返す。

---

## データフロー例

### ケース A: 編集 → 取り込み（正常系）

```
[User] "Module1 の Hello() に引数を追加して"
  ↓ (MDium がメッセージを <mdium_context> でラップして opencode に送信)
[LLM] list_vba_modules()
  ↓ (MCP → HTTP → MDium → 応答)
[Tool result] { exists: true, modules: [...] }
[LLM] (Read/Edit で Module1.bas を編集)
[LLM] import_vba_macros()
  ↓
[Tool result] { updatedModules: ["Module1"], backupPath: "Book1.xlsm.bak", ... }
  ↓ (MDium がプレビュー自動再読込 + トースト)
[LLM] "Module1 に name 引数を追加して取り込みました。Backup: Book1.xlsm.bak"
```

### ケース B: タブ切替後のユーザー意図確認（L1+L2 認識整合）

```
(会話序盤で Book1.xlsm を編集中 → ユーザーが Book2.xlsm タブに切替)
[User] "このマクロを修正して"
  ↓ (<mdium_context>active_file="Book2.xlsm"</mdium_context>)
[LLM] (直前のメッセージまでは Book1.xlsm だったのに、今は Book2.xlsm に変わっている → 意図確認)
[LLM] "アクティブタブが Book1.xlsm から Book2.xlsm に変わりましたが、
       Book2.xlsm の方を編集しますか？それとも Book1.xlsm の作業を続けますか？"
```

### ケース C: race condition（HTTP 層の active_tab_changed）

```
[LLM] import_vba_macros()
[MCP] GET /active-xlsm → "Book1.xlsm"
(この瞬間にユーザーがタブを Book2.xlsm に切替)
[MCP] POST /vba/inject {xlsm_path: "Book1.xlsm"}
[HTTP] 409 { error: "active_tab_changed", sentPath: "Book1.xlsm", activeFile: "Book2.xlsm" }
[MCP] (retry once)
[MCP] GET /active-xlsm → "Book2.xlsm"
[MCP] POST /vba/inject {xlsm_path: "Book2.xlsm"} → 成功 or ユーザー意図確認へ
```

---

## エラーハンドリング

| ケース | 層 | 挙動 |
|---|---|---|
| `.xlsm` が Excel でロック中 | MDium inject | OS I/O エラー文字列を HTTP 応答に含める → LLM が報告 |
| アクティブタブが resolve ↔ inject の間に変わった (race) | HTTP bridge | 409 `active_tab_changed` → MCP サーバーが 1 回 retry |
| `_macros/` が存在しない (import 時) | inject_vba_modules | `macroDirNotFound` 相当のエラー |
| モジュール構成変更（追加/削除/リネーム） | inject_vba_modules (strict) | xlsm 未変更で `module_set_changed` エラー返却。`newInFiles` / `missingInFiles` を同梱 |
| HTTP token 不一致 | HTTP bridge | 401 Unauthorized（通常起きない防御層） |
| MCP サーバープロセス起動失敗 | opencode | opencode の MCP エラー表示に委ねる |
| HTTP bridge ポート取得失敗 | MDium 起動時 | ログ出力して allowLlmVbaImport を強制 OFF |
| LLM がトグル OFF 時に "使いたい" と言う | — | MCP サーバーがそもそも混入していないのでツール不在エラー |

---

## セキュリティ

### HTTP bridge の隔離
- `127.0.0.1` のみバインド（ファイアウォール経由の外部到達不可）
- bearer token 認証（トークンはアプリ起動時にランダム生成、プロセス内のみ保持）
- トークンは env var 経由で子プロセス（MCP サーバー）にのみ渡す。ファイルには書かない
- ポートは OS に選ばせる（ランダム）→ポート固定に起因する衝突・推測を回避

### 書込対象の制限
- inject 対象は **現在のアクティブ xlsm タブ** のみ
- HTTP bridge は `sentPath`（MCP が送ったパス）と `activeFile`（今の時点のアクティブタブ）が一致することを必須とする
- MCP サーバーは `GET /active-xlsm` で取得した直後のパスのみ使用し、ユーザー/LLM が任意のパスを渡す余地は無い（ツール引数なし設計）
- 非 xlsm タブがアクティブなら `/active-xlsm` が `null` を返してツール即エラー
- `.xlsm.bak` は毎回上書き（履歴が欲しいユーザーは Git で管理）

### トグル既定値
- `allowLlmVbaImport` は初期値 **false**
- ユーザーがトグルを明示的に有効化するまで、MCP サーバーは一切 opencode に登録されない

---

## テスト戦略

### Rust 単体テスト
既存 `vba.rs` のテスト（圧縮/解凍/dir stream）はそのまま維持。

追加:
- `http_bridge` のトークン検証テスト
- `active_tab_mismatch` 時の 409 応答テスト
- bridge が呼び出す `extract_vba_modules` / `inject_vba_modules` の統合テスト（固定サンプル xlsm 使用）

### MCP サーバー (Node) 単体テスト
- env var 読み込み（必須 env 欠損で起動エラー）
- HTTP クライアントが正しい token / path を送る
- HTTP 応答をツール戻り値にマッピング
- 409 応答を LLM 向けエラー文字列に変換

### 手動 E2E
1. `.xlsm` を MDium で開く
2. プレビューのトグルを ON
3. opencode チャットを起動
4. LLM に「Module1 に PrintHello を追加して」と依頼
5. LLM が list → (必要なら extract) → edit → import の順に実行すること
6. プレビューが自動再読込されること、`.bak` が出力されること
7. Excel で xlsm を開き、変更が反映されていることを確認
8. タブを別 xlsm に切り替え、同じチャットに指示を送る → L2 エラーで拒否されること
9. トグルを OFF にして新規チャット起動 → MCP サーバーが混入していないこと

---

## 実装順序（Phase 1 の粗い分割）

1. `inject_vba_modules` に strict モード検出を追加（`module_set_changed` エラー返却）+ 既存 UI の i18n 対応
2. 新規 `list_vba_modules` Tauri コマンド実装（extract の ZIP+dir 解析部分を共有化）
3. `http_bridge.rs` と token 管理（Rust）+ `/vba/list`, `/vba/extract`, `/vba/inject` エンドポイント
4. アクティブタブ race 検出（HTTP bridge 内で `sentPath === activeFile` チェック、不一致時 `active_tab_changed` で 409）+ `GET /active-xlsm` エンドポイント
5. app settings に `allowLlmVbaImport` フィールド追加
6. `resources/mcp-servers/mdium-vba/` MCP サーバー実装（Node）
7. `useOpencodeChat.ts` — MCP サーバー env var 注入（トグル条件付き）
8. `useOpencodeChat.ts` — メッセージラップ (L1)
9. `PreviewPanel.tsx` — トグル UI + 成功時プレビュー再読込の共通化
10. `builtin-skills.ts` — vba-coding-conventions にセクション追加（トグル条件付き混入）
11. 手動 E2E テスト

詳細なタスク分解は別途 implementation plan で行う。

---

## Phase 2 (本 spec の対象外、将来別 spec)

以下は今回は実装せず、本 spec の拡張点だけ確保しておく。

- `run_vba_macro` ツール（Excel COM 自動化）
- 実行結果の取得（`Debug.Print` 捕捉 / 指定セル読み取り / 戻り値関数限定）
- 実行前の安全ガード（確認ダイアログ / 署名検証）
- サンドボックスコピーでの実行オプション
- Excel インスタンスのライフサイクル管理

**Phase 2 への拡張ポイント:**
- HTTP bridge のエンドポイントは名前空間を `/vba/` で切っているので `/vba/run` を足すだけ
- MCP サーバーはツールをレジストリで管理し、`run_vba_macro` を 1 ツール追加するだけ
- skill のセクション分けを「編集フロー / 実行フロー」と 2 段構成にできる余地を残す
