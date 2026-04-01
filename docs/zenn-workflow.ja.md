# Zenn記事ワークフロー

MDiumでは[Zenn](https://zenn.dev/)の記事作成・プレビュー・公開を一貫して行えます。

## 概要

```
work/{slug}/index.md  --[編集]--> プレビュー (Zenn記法対応)
work/{slug}/images/   --[編集]--> プレビュー (ローカル画像)
         |
         v  (deploy-zenn-article コマンド)
articles/{slug}.md  + images/*.png
         |
         v  (Gitパネル: commit & push)
GitHub --> Zenn (自動デプロイ)
```

## セットアップ

### 1. Zennフォルダの初期化

1. **設定**（左サイドバーの歯車アイコン）を開く
2. **その他** タブを選択
3. **Zennフォルダとして初期化** をクリック
4. **空のフォルダ** を選択

以下の構造が作成されます：

```
your-zenn-folder/
├── articles/       # 公開用記事（Git管理下）
├── books/          # 公開用書籍（Git管理下）
├── images/         # 公開用画像（Git管理下）
├── work/           # 下書き（.gitignoreでGit管理外）
└── .gitignore      # "work/" を含む
```

フォルダは `main` ブランチでGitリポジトリとして初期化されます。

### 2. GitHubとの連携

1. 左サイドバーの **Git** パネルを開く
2. Zenn連携済みのGitHubリポジトリのリモートURLを設定
3. Gitパネルからcommit・pushが可能になります

## 記事の執筆

### 新規記事の作成

1. プレビューツールバーの**コマンドドロップダウン**を開く
2. **create-zenn-article** を選択
3. AIが対話的に以下を聞きます：
   - **slug** — URL識別子（12-50文字、英小文字・数字・ハイフン・アンダースコア）
   - **title** — 記事タイトル
   - **emoji** — 絵文字1つ
   - **type** — `tech`（技術記事）または `idea`（アイデア・意見）
   - **topics** — 最大5つのタグ
4. `work/{slug}/index.md` にfrontmatter付きで記事が作成されます

### 記事ごとのフォルダ構成

```
work/
└── my-article/
    ├── index.md        # 記事本文（frontmatter付き）
    └── images/         # 記事で使用する画像
        ├── screenshot.png
        └── diagram.svg
```

記事内では相対パスで画像を参照します：

```markdown
![スクリーンショット](images/screenshot.png)
```

### フロントマターの編集

Zenn記事（`work/` または `articles/` 配下）を開くと、プレビューパネル上部に**フロントマター編集フォーム**が表示されます：

- 絵文字、タイトル、タイプ（tech/idea）、公開フラグ、トピックタグ
- 変更はリアルタイムでエディタに反映されます

### Zenn記法のサポート

プレビューではZenn独自の記法が自動的にレンダリングされます：

**メッセージブロック：**
```markdown
:::message
デフォルトの情報メッセージ
:::

:::message alert
警告メッセージ
:::
```

**折りたたみ：**
```markdown
:::details クリックして展開
隠れたコンテンツ
:::
```

**ファイル名付きコードブロック：**
````markdown
```js:src/index.js
console.log("hello");
```
````

**画像サイズ指定：**
```markdown
![alt](url =250x)
```

### 校正

1. エディタで記事を開く
2. コマンドドロップダウンから **proofread-zenn-article** を選択
3. AIが記事を読み取り、以下を提案します：
   - 文法・スペルの修正
   - 技術的な正確性の確認
   - 可読性の改善
   - Zenn記法の使い方の提案

## 公開

### 公開用ディレクトリへのデプロイ

1. エディタで記事（`work/{slug}/index.md`）を開く
2. コマンドドロップダウンから **deploy-zenn-article** を選択
3. 以下がコピーされます：
   - `work/{slug}/index.md` → `articles/{slug}.md`
   - `work/{slug}/images/*` → `images/`（フラットにコピー）
4. コピーされた `.md` 内の画像パスは `/images/filename.png` に書き換えられます

### GitHubへのプッシュ

1. **Git** パネルを開く
2. 変更をステージング（`articles/` と `images/` のファイル）
3. コミットメッセージを入力
4. **Commit** → **Push** をクリック

Zennが連携済みGitHubリポジトリから自動デプロイします。

## Zennモード

ワークスペースフォルダ内に `articles/`、`books/`、`images/` の3つのディレクトリがすべて存在する場合、MDiumは自動的にZennプロジェクトとして認識します。Zennモードでは：

- ファイルツリーが記事執筆用に最適化（画像表示、Office/PDF/マインドマップ非表示）
- プレビューでZenn記法がレンダリング
- 記事にフロントマター編集フォームが表示
- Zenn関連コマンドがコマンドドロップダウンに表示

## コマンドリファレンス

| コマンド | 説明 | 入力 |
|---------|------|------|
| `create-zenn-article` | 新規記事を対話的に作成 | なし（AIが質問） |
| `proofread-zenn-article` | 現在の記事を校正 | 現在のファイルパス |
| `deploy-zenn-article` | work/ から articles/ + images/ にコピー | 現在のファイルパス |
