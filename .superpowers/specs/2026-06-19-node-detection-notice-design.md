# Node 未検出時のユーザー案内 — 設計

日付: 2026-06-19

## 背景・課題

MDium は Tauri アプリで、インストーラに Node.js を同梱していない。Node 依存機能（AI チャット / Slidev / 動画生成）は PATH 上の外部コマンド（`opencode`, `node`/`npx`）を起動する設計のため、Node 未インストール環境では:

- AI チャット: `cmd /C opencode serve` 経由で spawn 自体は成功扱いになり、その後 20回×500ms ポーリングして**タイムアウト（最大10秒ハング）**。原因が分からない。
- Slidev / 動画: `npx.cmd` の spawn が失敗し、**生のエラー文字列**が表示される（原因が不明瞭）。

ユーザーに「Node（または opencode）が見つからない」ことを明確に案内し、インストール導線を提示する。

## 方針

既存資産を活用する:

- Rust コマンド `check_command_exists(name) -> bool`（`where`/`which` ベース、`lib.rs` 登録済み）
- Rust コマンド `open_external_url(url)`（外部ブラウザでURLを開く、既存）
- 既存パターン: `video_check_ffmpeg` → `alert(t("ffmpegNotFound"))`（フロント事前チェック＋通知）

**各 Node 依存機能の実行直前に必要コマンドの有無を確認**し、無ければローカライズ済みメッセージ＋インストール導線を `window.confirm` で提示して処理を中断する。

confirm ベースを採用する理由: opencode 起動箇所 `ensureOpencodeServer` は React コンポーネントではなくモジュール関数のため、モーダル state を持てない。`confirm`/`alert` は既存コードでも使われ、どこからでも呼べてリンク導線も出せる。

## アーキテクチャ

### 共有ヘルパー: `src/shared/lib/ensureCommand.ts`

```ts
ensureCommand(command: string, opts: {
  messageKey: string;   // 未検出メッセージの i18n キー (ns: common)
  promptKey: string;    // 「インストール方法を開きますか？」の i18n キー
  installUrl: string;   // 導線URL
}): Promise<boolean>
```

挙動:
1. `invoke<boolean>("check_command_exists", { name: command })` を呼ぶ。例外時は `false`（安全側＝未検出扱い）。
2. 存在すれば `true` を返す。
3. 未検出なら `window.confirm(i18n.t(messageKey) + "\n\n" + i18n.t(promptKey))` を表示。
   - OK の場合 `invoke("open_external_url", { url: installUrl })`。
   - いずれの場合も `false` を返す（＝呼び出し側は機能を起動しない）。

翻訳は `i18n from "@/shared/i18n"`（グローバルインスタンス）を使用し、非コンポーネント文脈からも引けるようにする。

### 定数: 必要コマンドと導線

ヘルパー利用側でキー/URLを渡す。Node 系の導線URLは i18n キー（`nodeInstallUrl`）からではなく定数 `https://nodejs.org/` を共有定義（`ensureCommand.ts` 内に `NODE_INSTALL_URL`, `OPENCODE_INSTALL_URL` をエクスポート）。

- `node` 用導線: `https://nodejs.org/`
- `opencode` 用導線: `https://opencode.ai/docs/` （インストール手順ページ）

## 注入ポイント（機能ごとに必要コマンドを個別チェック）

| 機能 | ファイル / 箇所 | チェック対象 | 導線 |
|---|---|---|---|
| AI チャット | `useOpencodeChat.ts` `ensureOpencodeServer`（`spawn_background_process` 直前） | `opencode` | OPENCODE_INSTALL_URL |
| Slidev プレビュー起動 | `SlidevPreviewPanel.tsx` `startServer`（`slidev_start` 直前） | `node` | NODE_INSTALL_URL |
| Slidev エクスポート | `SlidevPreviewPanel.tsx` `handleExport`（`slidev_export` 直前） | `node` | NODE_INSTALL_URL |
| 動画エクスポート | `VideoPanel.tsx` `handleExport`（既存 ffmpeg チェック隣） | `node` | NODE_INSTALL_URL |

備考: Slidev / 動画の実コマンドは `npx` だが、npx は node に同梱されるため、ユーザーの質問の趣旨どおり `node` の有無で判定する。AI チャットは node だけでは不十分なので `opencode` 自体を確認する。

未検出時の各呼び出し側の挙動:
- AI チャット: `ensureOpencodeServer` の先頭でチェックし、未検出なら例外を投げる（既存のエラーハンドリングが受ける）か、サーバ起動をスキップして明示エラーを返す。10秒ハングを解消することが目的。
- Slidev: `startServer` 冒頭で未検出なら `setStarting(false)` 等の状態を戻して return（自動再起動 useEffect がループしないようガード）。
- 動画: ffmpeg チェックと同様に return。

## i18n（`common.json` に追加。ハードコード禁止方針を順守）

en / ja 両方に追加:

- `nodeNotFound`: "Node.js was not found. This feature (Slidev / video generation) requires Node.js." 相当
- `opencodeNotFound`: "The 'opencode' command was not found. AI chat requires opencode to be installed." 相当
- `openInstallGuide`: "Open the installation guide?" 相当（confirm のプロンプト行）

導線URLはコード内定数（翻訳対象外）。

## エラーハンドリング

- `check_command_exists` の invoke 失敗 → `false`（未検出扱い）で安全側。
- 未検出時は対象機能を起動しない（即 return / throw）。

## テスト

`src/shared/lib/__tests__/ensureCommand.test.ts`（vitest, `@tauri-apps/api/core` の `invoke` をモック）:

1. コマンド存在時 → `true` を返し、confirm を呼ばない。
2. コマンド未検出 + confirm OK → `false` を返し、`open_external_url` を `installUrl` 付きで invoke する。
3. コマンド未検出 + confirm キャンセル → `false` を返し、`open_external_url` を呼ばない。
4. `check_command_exists` が reject → `false` を返す（安全側）。

## スコープ外（YAGNI）

- 起動時バナーによる常時案内（今回はトリガー＝機能利用時の事前チェックのみ）。
- Node 自体の自動インストール。
- opencode のワンクリックインストール（既存の terminal 導線が別途存在）。
