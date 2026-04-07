# Slidev Dynamic npm Install Design

## Summary

Slidev の node_modules (~413MB) をアプリバンドルから完全に除外し、初回プレビュー時に `npm install` で動的にインストールする。プロキシ環境下でも動作し、ビルドサイズとビルド時間を大幅に改善する。

## Background

- 現状: `resources/slidev-env/node_modules/` に `@slidev/cli`, `@slidev/theme-default`, `playwright-chromium` を含む ~413MB のパッケージをバンドル
- Tauri の `bundle.resources` で丸ごとインストーラに同梱しており、ビルドサイズとビルド時間が問題になっている
- プロキシ環境下でも `HTTP_PROXY` 環境変数 or `npm config set proxy` でレジストリアクセス可能

## Design

### 1. バンドルリソース（最小化）

```
resources/slidev-env/
├── package.json          # 全依存の定義（slidev + playwright-chromium）
└── package-lock.json     # 再現性のあるインストールのため
```

- node_modules は一切バンドルしない
- `tauri.conf.json` の `bundle.resources` から `../resources/slidev-env/**/*` を `../resources/slidev-env/package.json`, `../resources/slidev-env/package-lock.json` に変更
- Before: ~413MB → After: 数KB

### 2. ランタイムディレクトリ構成

#### AppData（永続インストール先）

```
%APPDATA%/com.mdium.app/
└── slidev-env/
    ├── package.json
    ├── package-lock.json
    └── node_modules/
        ├── @slidev/cli/
        ├── @slidev/theme-default/
        └── playwright-chromium/
```

- 全セッションで共有
- 一度インストールすれば再起動後もそのまま利用可能

#### temp ディレクトリ（セッションごと）

```
%TEMP%/mdium-slidev/{hash}/
├── slides.md
├── package.json            # AppData からコピー
├── node_modules/           # AppData の node_modules への junction (Windows) / symlink (Unix)
└── public/
```

- `node_modules` はフルコピーせず、junction / symlink で AppData を参照

### 3. インストール判定ロジック

Slidev プレビュー開始時（`slidev_start` 呼び出し時）に以下の順序でチェック:

1. AppData に `slidev-env/package.json` が存在するか → なければ初回インストール
2. バンドルの `package.json` の `dependencies` と AppData の `package.json` の `dependencies` が一致するか → 不一致ならバージョン更新インストール
3. AppData に `node_modules/@slidev/cli/package.json` が存在するか → なければ壊れた状態として再インストール

### 4. Rust 実装変更

#### 新関数: `ensure_slidev_installed(app: &AppHandle) -> Result<PathBuf>`

```
処理フロー:
  1. AppData パス取得: app.path().app_data_dir() / "slidev-env"
  2. バンドルの package.json を読み込み（リソースディレクトリから）
  3. AppData の package.json と比較
     - 一致 & node_modules 存在 → AppData パスを返す（インストール不要）
     - 不一致 or 未インストール → インストール実行
  4. インストール実行:
     a. イベント発火: slidev-install-start
     b. package.json, package-lock.json を AppData にコピー
     c. Command::new("npm").args(["install"]).current_dir(appdata_slidev) を実行
        - 親プロセスの環境変数を継承（HTTP_PROXY, HTTPS_PROXY 自動引き継ぎ）
        - ユーザーの .npmrc 設定も npm が自動読み込み
     d. 成功 → slidev-install-complete 発火、AppData パスを返す
     e. 失敗 → slidev-install-error { message } 発火（プロキシヒント付加）
```

#### `slidev_start` の変更

```
Before:
  → リソースの node_modules を temp にフルコピー
  → temp で slidev dev 起動

After:
  → ensure_slidev_installed() で AppData にインストール確認/実行
  → temp ディレクトリ作成
  → AppData/slidev-env/node_modules を temp に junction (Windows) / symlink (Unix)
  → AppData/slidev-env/package.json を temp にコピー
  → temp で slidev dev 起動
```

#### `slidev_export` の変更

- junction 経由で AppData の playwright-chromium が参照できるため、基本的に変更不要

#### 削除対象

- `copy_dir_recursive` による node_modules フルコピー処理

### 5. junction / symlink 作成

```rust
// Windows: ディレクトリ junction（管理者権限不要）
// symlink_dir は管理者権限が必要なため、mklink /J を使用
Command::new("cmd").args(["/C", "mklink", "/J", dest, source]).output()

// Unix: symlink
std::os::unix::fs::symlink(source, dest)
```

### 6. プロキシ対応

- `std::process::Command` はデフォルトで親プロセスの環境変数を継承
- `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` が自動で npm に渡る
- npm は `.npmrc` の `proxy` 設定も自動読み込み
- アプリ側で特別なプロキシ処理は不要
- エラー時に「プロキシ環境の場合は `HTTP_PROXY` 環境変数または `npm config set proxy` を確認してください」というヒントを表示

### 7. フロントエンド変更

#### `SlidevPreviewPanel.tsx`

- Tauri イベントをリッスン:
  - `slidev-install-start` — インストール開始
  - `slidev-install-complete` — インストール完了
  - `slidev-install-error { message }` — エラー
- インストール中: 「Slidev環境をインストール中...」メッセージ表示
- エラー時: エラーメッセージ + プロキシヒント + リトライボタン

#### i18n キー追加

- `slidev.install.inProgress` — インストール中メッセージ
- `slidev.install.complete` — インストール完了
- `slidev.install.error` — エラーメッセージ
- `slidev.install.errorHint` — プロキシ設定のヒント

### 8. バージョン管理

- アプリ更新時、バンドルの `package.json` の `dependencies` が変更されていれば自動で `npm install` し直す
- `dependencies` オブジェクト全体の文字列比較でシンプルに判定

## Out of Scope

- オフラインインストール対応（プロキシ経由でレジストリアクセス可能なため不要）
- 手動インストール/更新 UI（自動判定で対応）
- テーマの動的インストール（既存機能として維持）
