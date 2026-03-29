# MDium

React、TypeScript、Tauri で構築された、多機能ドキュメントエディタ＆ワークスペース管理アプリケーション。

Markdown 編集、AI アシスタント、マインドマップ、Office ドキュメント対応、開発者ツールを一つのデスクトップアプリに統合しています。

[English README](README.md)

## 機能

### Markdown 編集

- エディタとプレビューの分割表示（リアルタイムプレビュー）
- GitHub Flavored Markdown（GFM）対応
- 数式表示（KaTeX）
- Mermaid ダイアグラム（フローチャート、シーケンス図、ER図、ガントチャート、クラス図、状態図、円グラフ）
- コードのシンタックスハイライト（18言語以上）
- クリップボードからの画像貼り付け（Ctrl+V）— プレビューダイアログ＆AI による代替テキスト自動生成
- 検索・置換（Ctrl+F / Ctrl+H）
- スクロール同期・自動保存
- ドキュメントアウトライン表示

### マルチフォーマット対応

- **Markdown**（.md）— メイン編集フォーマット
- **Office ドキュメント**（.docx, .xlsx, .xlsm）— 閲覧・変換
- **マインドマップ**（.km, .xmind）— インタラクティブなビジュアル編集
- **PDF**（.pdf）— 閲覧・Markdown への変換
- **画像**（.png, .jpg, .gif, .bmp, .svg, .webp 等）— プレビュー・キャンバス編集
- DOCX/Markdown の双方向変換
- PDF エクスポート

### AI 連携

- RAG（検索拡張生成）によるドキュメント Q&A
- 設定可能な埋め込みモデルによるセマンティック検索（multilingual-e5-large、Ruri v3 等）
- opencode-sdk によるコンテンツ生成（エディタへの AI テキスト挿入）
- 複数 API プロバイダー対応：OpenAI、Anthropic、DeepSeek、Azure、Gemini、Grok、Groq、Ollama、カスタムエンドポイント
- チャットセッション管理・履歴保持
- UNC パス対応（ネットワークドライブ）

### 音声入力

- Whisper ベースの音声認識（whisper-small、whisper-large-v3-turbo）
- Web Worker によるノンブロッキング処理
- エディタへの直接テキスト挿入
- モデルダウンロード（進捗表示付き）

### AI 画像生成

- ビルトイン MCP サーバー（Nano Banana 2）による Gemini ベースの AI 画像生成
- エディタ上でテキストプロンプトから画像を生成（右クリック → 挿入 → 画像 → MCP で生成）
- 生成画像は `images/` ディレクトリに自動保存され、Markdown として挿入

### マインドマップエディタ

- ReactFlow を使用したインタラクティブなノードベース編集
- テーマ・レイアウトのカスタマイズ
- ノードへのハイパーリンク・画像挿入
- KM・XMind フォーマット対応

### ファイルエクスプローラー

- ファイルツリーエクスプローラー（フォルダナビゲーション）
- マルチフォルダワークスペース（タブ対応）
- ドラッグ＆ドロップによるファイル操作（ツリー内の移動/コピー）
- OS からのファイルインポート（システムファイルマネージャーからドラッグ）
- 切り取り/コピー/貼り付け操作（Ctrl+X / Ctrl+C / Ctrl+V）
- インラインファイル名変更（F2）
- デフォルトアプリケーションで開く
- ファイルタイプ別フィルタリング（画像, .docx, .xls\*, .km/.xmind, .pdf）＋「すべて表示」モード
- ファイル監視・自動リフレッシュ
- コンテキストメニュー（名前変更、削除、コピー、切り取り、貼り付け、デフォルトアプリで開く）

### Git ソースコントロール

- 左アクティビティバーに統合された Git パネル
- リポジトリ初期化（main ブランチ）
- ファイルのステージ/アンステージ
- メッセージ入力によるコミット
- AI によるコミットメッセージ自動生成
- リモートへのプッシュ / リモート URL 管理
- ブランチ一覧・切り替え
- 変更の破棄（追跡済み・未追跡）

### 統合ターミナル

- xterm.js ベースのターミナル（PTY バックエンド）
- フォルダごとのターミナルセッション

### 開発者ツール連携

- opencode AI ツール連携（チャット、MCP サーバー設定、スキル/エージェント/ツール管理）
- Git 操作（init、add、commit、push、branch）
- MCP サーバーテスト
- Zenn 記法の Markdown レンダリング対応

### テーマ＆カスタマイズ

- 複数のビルトインテーマ（ライト/ダーク）
- フォント、カラー、レイアウトのカスタマイズ
- 外部ツールとのテーマ同期
- 日本語/英語 UI

## 技術スタック

| レイヤー               | 技術                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| フロントエンド         | [React](https://github.com/facebook/react) 19、[TypeScript](https://github.com/microsoft/TypeScript) 5.9、[Vite](https://github.com/vitejs/vite) 7                                                                                                        |
| 状態管理               | [Zustand](https://github.com/pmndrs/zustand)                                                                                                                                                                                                        |
| デスクトップ           | [Tauri](https://github.com/tauri-apps/tauri) 2                                                                                                                                                                                                      |
| バックエンド           | [Rust](https://github.com/rust-lang/rust)（[Tokio](https://github.com/tokio-rs/tokio)、[rusqlite](https://github.com/rusqlite/rusqlite)、[reqwest](https://github.com/seanmonstar/reqwest)、[portable-pty](https://github.com/wez/wezterm/tree/main/pty)）       |
| Markdown               | [marked](https://github.com/markedjs/marked)、[remark](https://github.com/remarkjs/remark)、[KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid)、[highlight.js](https://github.com/highlightjs/highlight.js)              |
| AI/ML                  | [Hugging Face Transformers](https://github.com/huggingface/transformers.js)、[Tesseract.js](https://github.com/naptha/tesseract.js)                                                                                                                    |
| Office                 | [docx](https://github.com/dolanmiu/docx)、[mammoth](https://github.com/mwilliamson/mammoth.js)、[xlsx](https://github.com/SheetJS/sheetjs)、[pdfjs-dist](https://github.com/nicolo-ribaudo/pdfjs-dist)、[html2pdf.js](https://github.com/eKoopmans/html2pdf.js) |
| ビジュアライゼーション | [ReactFlow](https://github.com/xyflow/xyflow)、[d3-hierarchy](https://github.com/d3/d3-hierarchy)、[Fabric.js](https://github.com/fabricjs/fabric.js)                                                                                                     |
| ターミナル             | [xterm.js](https://github.com/xtermjs/xterm.js)                                                                                                                                                                                                     |

## はじめに

### 前提条件

- [Node.js](https://nodejs.org/)（v18 以上）
- [Rust](https://www.rust-lang.org/tools/install)
- npm

### インストール

```bash
git clone https://github.com/straygizmo/mdium.git
cd mdium
npm install
```

### 開発

```bash
# Vite 開発サーバーの起動
npm run dev

# Tauri デスクトップアプリを開発モードで起動
npm run tauri dev
```

### ビルド

```bash
# プロダクションビルド
npm run build

# 配布用デスクトップアプリの作成
npm run tauri build
```

### テスト

```bash
npm run test          # テストを1回実行
npm run test:watch    # ウォッチモード
```

## キーボードショートカット

キーボードショートカットの一覧は [docs/keyboard-shortcuts.ja.md](docs/keyboard-shortcuts.ja.md) を参照してください。

## プロジェクト構成

```
mdium/
├── src/
│   ├── app/               # メインアプリ、ツールバー、タブ、ステータスバー
│   ├── features/          # 機能モジュール
│   │   ├── ai/            # AI 生成
│   │   ├── claude-config/  # Claude Code 設定
│   │   ├── editor/        # Markdown エディタ
│   │   ├── export/        # DOCX/PDF エクスポート
│   │   ├── file-tree/     # ファイルエクスプローラー＆左パネル
│   │   ├── git/           # Git ソースコントロールパネル
│   │   ├── image/         # 画像キャンバスエディタ
│   │   ├── mindmap/       # マインドマップエディタ
│   │   ├── opencode-config/ # opencode AI ツール設定
│   │   ├── preview/       # Markdown プレビュー
│   │   ├── rag/           # RAG Q&A パネル
│   │   ├── search/        # 検索/置換
│   │   ├── settings/      # 設定ダイアログ
│   │   ├── speech/        # 音声入力
│   │   ├── table/         # テーブルエディタ
│   │   ├── terminal/      # 統合ターミナル
│   │   └── zenn/          # Zenn プラットフォーム対応
│   ├── shared/            # 型定義、フック、ユーティリティ、テーマ、i18n
│   └── stores/            # Zustand ストア
├── src-tauri/             # Tauri/Rust バックエンド
│   └── src/commands/      # バックエンドコマンド（ファイル、AI、PTY、Git、RAG、音声、MCP）
├── public/                # 静的アセット・テーマファイル
└── scripts/               # ビルド・インポートスクリプト
```

## ライセンス

[MIT](LICENSE) - Copyright (c) 2025 straygizmo
