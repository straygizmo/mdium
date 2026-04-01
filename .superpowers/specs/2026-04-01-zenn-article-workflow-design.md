# Zenn Article Workflow — Design Spec

## Overview

Zennの記事作成→プレビュー→GitHub Pushフローを、既存のコマンドシステムとGitパネルを最大活用しつつ、最小限のUI拡張で実現する。作業フォルダ（`work/`）とアップロード用フォルダ（`articles/`, `images/`）を分離し、コマンドでパス変換付きコピーを行う。

## Goals

1. 設定画面からZennフォルダの初期化（git init + ディレクトリ構造作成）を行える
2. フォルダ構造ベースのZennモード自動判定
3. コマンドによるAI対話型の記事スキャフォールド生成・校正・デプロイ準備
4. Zennモード時のプレビュー自動切替 + frontmatterフォーム表示
5. Push は既存Gitパネルをそのまま利用（Zenn独自実装なし）

## Design

### 1. フォルダ構成

```
zenn-repo/
├── work/                    # 作業フォルダ（.gitignore登録、Git管理外）
│   └── my-article/          # 記事ごとのサブフォルダ（slug名）
│       ├── index.md          # 記事本文（frontmatter付き）
│       └── images/           # 記事で使う画像
│           ├── img1.png
│           └── img2.png
├── articles/                # アップロード用（Zennが読む）
│   └── my-article.md        # deploy-zenn-articleコマンドでコピーされる
├── books/                   # アップロード用（Zennが読む）
├── images/                  # アップロード用画像（Zennが読む）
│   ├── img1.png             # work/{slug}/images/ からフラットにコピー
│   └── img2.png
└── .gitignore               # work/ を除外
```

### 2. Zennモード判定

ワークスペースフォルダ内に `articles/`、`books/`、`images/` の3ディレクトリがすべて存在するかで判定（AND条件）。

- フォルダオープン/切替時に一度チェック
- 3つすべて揃っている場合のみ `isZennMode: true`
- 結果を既存ストアに `isZennMode: boolean` フラグとして保持
- ファイル個別のチェックは不要（フォルダ単位の判定）

### 3. 設定画面 — 「その他」タブ

設定ダイアログに「Other」タブを追加。

#### UI

- 「Zennフォルダとして初期化」ボタン
- クリック → Tauriフォルダ選択ダイアログ

#### 初期化処理

選択したフォルダに対して以下を実行:

0. フォルダが空でない場合はエラーメッセージを表示して中断
1. `git init`
2. ブランチ名を `main` に設定
3. `articles/` ディレクトリ作成
4. `books/` ディレクトリ作成
5. `images/` ディレクトリ作成
6. `work/` ディレクトリ作成
7. `.gitignore` に `work/` を追加（ファイルが既存の場合は追記）
8. 初期化完了後、そのフォルダをワークスペースとして開く

既存のTauri gitコマンド（`git_init` 等）とfsコマンドを利用。

### 4. ビルトインコマンド

#### `create-zenn-article`

- プレビューツールバーのコマンドドロップダウンから実行
- `$ARGUMENTS` は使用しない（AIが対話的にslug/title/emoji/type/topicsをユーザーに聞く）
- 生成先: `work/{slug}/index.md`（作業フォルダ内）
- `work/{slug}/images/` ディレクトリも合わせて作成
- frontmatter形式:

```yaml
---
title: ""
emoji: ""
type: "tech" # or "idea"
topics: []
published: false
---
```

#### `proofread-zenn-article`

- `$ARGUMENTS` に現在のファイルパスが渡る
- 記事内容を読み取り、技術記事としての校正・改善提案
- Zenn独自記法（:::message, :::details 等）を考慮

#### `deploy-zenn-article`

- `$ARGUMENTS` に現在のファイルパス（`work/{slug}/index.md`）が渡る
- 処理内容:
  1. `work/{slug}/index.md` → `articles/{slug}.md` にコピー
  2. `work/{slug}/images/*` → `images/` にフラットにコピー
  3. コピー先の `.md` 内の画像パス（相対パス `images/img1.png`）を Zenn用パス（`/images/img1.png`）に変換
- AIがファイル操作ツールを使って実行

### 5. プレビュー — Zennモード自動切替

#### preprocessZenn 自動適用

- ストアの `isZennMode` フラグを参照
- `true` の場合、既存の `preprocessZenn()` をMarkdownレンダリング前に自動適用

#### ZennFrontmatterForm 表示

- 条件: `isZennMode === true` かつ開いているファイルが `work/` または `articles/` 配下の `.md`
- プレビューパネル上部に既存の `ZennFrontmatterForm` を表示
- フォームの変更はエディタのfrontmatter部分に反映（フォーム→エディタ: frontmatterテキストを書き換え、エディタ→フォーム: Markdownパース時にfrontmatterを抽出してフォームstateに反映）

### 6. 不要コンポーネントの削除

以下のコンポーネントは削除する（コマンド/既存Gitパネルで代替）:

- `src/features/zenn/components/ZennNewArticleDialog.tsx` + `.css`
- `src/features/zenn/components/ZennPublishPanel.tsx` + `.css`

保持:
- `src/features/zenn/components/ZennFrontmatterForm.tsx` + `.css`

### 7. i18n

新規キー（en/ja 両方）:

- 設定画面「その他」タブ名
- 「Zennフォルダとして初期化」ボタンラベル
- 初期化完了メッセージ
- コマンド説明文

### 8. 変更ファイル一覧（想定）

| ファイル | 変更内容 |
|---------|---------|
| `src/features/settings/` | 「その他」タブ + Zenn初期化UI |
| `src/stores/` | `isZennMode` フラグ追加、フォルダオープン時の判定 |
| `src/features/opencode-config/lib/builtin-commands.ts` | 3コマンド追加 |
| `src/features/opencode-config/lib/builtin-registry.ts` | レジストリに登録 |
| `src/features/preview/components/PreviewPanel.tsx` | Zennモード自動適用 + FrontmatterForm統合 |
| `src/features/zenn/components/ZennNewArticleDialog.*` | 削除 |
| `src/features/zenn/components/ZennPublishPanel.*` | 削除 |
| `src/shared/i18n/locales/{en,ja}/` | 新規キー追加 |
| `src/shared/hooks/useFileFilters.ts` | isZennMode連携（既存コードあり） |

## Non-Goals

- Zenn専用のPublish UI（既存Gitパネルで十分）
- 記事作成時のGUIフォーム（AIコマンドで対話的に生成）
- Zenn CLIの統合
- Books機能のフルサポート（ディレクトリ作成のみ）
