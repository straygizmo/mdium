export const OFFICE_EXTENSIONS = [".docx", ".xlsx", ".xlsm", ".xlam"];
export const MINDMAP_EXTENSIONS = [".km", ".xmind"];
export const PDF_EXTENSIONS = [".pdf"];
export const CSV_EXTENSIONS = [".csv", ".tsv"];
export const IMAGE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp",
];

export function getOfficeExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return OFFICE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export function getMindmapExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return MINDMAP_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export function getPdfExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return PDF_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export function getCsvExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return CSV_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export function getImageExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

/**
 * Returns true if the file should be opened in the code editor
 * (i.e., it is not Markdown, Office, PDF, image, mindmap, CSV, or video JSON).
 */
export function isCodeFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md")) return false;
  if (lower.endsWith(".video.json")) return false;
  if (getOfficeExt(lower)) return false;
  if (getPdfExt(lower)) return false;
  if (getMindmapExt(lower)) return false;
  if (getCsvExt(lower)) return false;
  if (getImageExt(lower)) return false;
  return true;
}

export const MERMAID_GENERATE_PROMPT =
  "You are a Mermaid diagram generator. " +
  "Based on the user's description, generate appropriate Mermaid diagram source code. " +
  "Output ONLY the raw Mermaid source. Do NOT include code fences, explanation, or any other text.";

export const TRANSFORM_OPTIONS = [
  {
    id: "translate",
    labelKey: "ai.translate",
    prompt:
      "Translate the following text. If it is Japanese, translate to English. If it is English, translate to Japanese. " +
      "Return ONLY the translated text, no explanations.",
  },
  {
    id: "summarize",
    labelKey: "ai.summarize",
    prompt:
      "Summarize the following text concisely in Japanese. Return ONLY the summary, no additional commentary.",
  },
  {
    id: "proofread",
    labelKey: "ai.proofread",
    prompt:
      "Proofread and correct any grammatical or spelling errors in the following text. " +
      "Preserve the original language and tone. Return ONLY the corrected text.",
  },
  {
    id: "bullets",
    labelKey: "ai.bullets",
    prompt:
      "Convert the following text into a Markdown bullet list using '- ' prefix. " +
      "Return ONLY the bullet list, one item per line.",
  },
] as const;

export interface MermaidTemplate {
  labelKey: string;
  code: Record<string, string>;
}

export const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    labelKey: "mermaid.flowchart",
    code: {
      ja: `flowchart LR
  開始([開始]) --> 受注[受注処理]
  受注 --> 確認{在庫確認}
  確認 -->|あり| 出荷[出荷手配]
  確認 -->|なし| 発注[仕入発注]
  発注 --> 入荷[入荷処理]
  入荷 --> 出荷
  出荷 --> 請求[請求処理]
  請求 --> 終了([終了])`,
      en: `flowchart LR
  Start([Start]) --> Order[Order Processing]
  Order --> Check{Stock Check}
  Check -->|Available| Ship[Arrange Shipment]
  Check -->|Unavailable| Purchase[Purchase Order]
  Purchase --> Receive[Receive Goods]
  Receive --> Ship
  Ship --> Invoice[Invoicing]
  Invoice --> End([End])`,
    },
  },
  {
    labelKey: "mermaid.sequence",
    code: {
      ja: `sequenceDiagram
  actor ユーザー
  participant フロント as フロントエンド
  participant API as バックエンドAPI
  participant DB as データベース
  ユーザー->>フロント: ログイン要求
  フロント->>API: 認証リクエスト
  API->>DB: ユーザー照合
  DB-->>API: ユーザー情報
  API-->>フロント: JWTトークン
  フロント-->>ユーザー: ログイン成功`,
      en: `sequenceDiagram
  actor User
  participant Front as Frontend
  participant API as Backend API
  participant DB as Database
  User->>Front: Login Request
  Front->>API: Auth Request
  API->>DB: User Lookup
  DB-->>API: User Info
  API-->>Front: JWT Token
  Front-->>User: Login Success`,
    },
  },
  {
    labelKey: "mermaid.class",
    code: {
      ja: `classDiagram
  class ユーザー {
    +int id
    +string 名前
    +string メール
    +ログイン() bool
    +ログアウト() void
  }
  class 管理者 {
    +string 権限レベル
    +ユーザー削除(id) void
  }
  class 一般ユーザー {
    +int ポイント
    +ポイント使用(amount) void
  }
  ユーザー <|-- 管理者
  ユーザー <|-- 一般ユーザー`,
      en: `classDiagram
  class User {
    +int id
    +string name
    +string email
    +login() bool
    +logout() void
  }
  class Admin {
    +string permissionLevel
    +deleteUser(id) void
  }
  class Member {
    +int points
    +usePoints(amount) void
  }
  User <|-- Admin
  User <|-- Member`,
    },
  },
  {
    labelKey: "mermaid.stateDiagram",
    code: {
      ja: `stateDiagram-v2
  [*] --> 待機中
  待機中 --> 処理中 : 開始
  処理中 --> 完了 : 成功
  処理中 --> エラー : 失敗
  エラー --> 待機中 : リトライ
  完了 --> [*]
  エラー --> [*] : キャンセル`,
      en: `stateDiagram-v2
  [*] --> Idle
  Idle --> Processing : Start
  Processing --> Completed : Success
  Processing --> Error : Failure
  Error --> Idle : Retry
  Completed --> [*]
  Error --> [*] : Cancel`,
    },
  },
  {
    labelKey: "mermaid.er",
    code: {
      ja: `erDiagram
  顧客 ||--o{ 注文 : "する"
  注文 ||--|{ 注文明細 : "含む"
  商品 ||--o{ 注文明細 : "含まれる"
  顧客 {
    int 顧客ID PK
    string 氏名
    string 電話番号
  }
  注文 {
    int 注文ID PK
    int 顧客ID FK
    date 注文日
  }
  商品 {
    int 商品ID PK
    string 商品名
    int 価格
  }`,
      en: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ ORDER_DETAIL : contains
  PRODUCT ||--o{ ORDER_DETAIL : "included in"
  CUSTOMER {
    int customerID PK
    string name
    string phone
  }
  ORDER {
    int orderID PK
    int customerID FK
    date orderDate
  }
  PRODUCT {
    int productID PK
    string productName
    int price
  }`,
    },
  },
  {
    labelKey: "mermaid.gantt",
    code: {
      ja: `gantt
  title プロジェクト計画
  dateFormat YYYY-MM-DD
  section 企画フェーズ
    要件定義      :a1, 2025-04-01, 14d
    設計書作成    :a2, after a1, 7d
  section 開発フェーズ
    フロント開発  :b1, after a2, 21d
    バックエンド  :b2, after a2, 21d
    テスト        :b3, after b1, 14d
  section リリース
    UAT           :c1, after b3, 7d
    本番リリース  :c2, after c1, 1d`,
      en: `gantt
  title Project Plan
  dateFormat YYYY-MM-DD
  section Planning Phase
    Requirements    :a1, 2025-04-01, 14d
    Design Document :a2, after a1, 7d
  section Development Phase
    Frontend Dev    :b1, after a2, 21d
    Backend Dev     :b2, after a2, 21d
    Testing         :b3, after b1, 14d
  section Release
    UAT             :c1, after b3, 7d
    Production      :c2, after c1, 1d`,
    },
  },
  {
    labelKey: "mermaid.pie",
    code: {
      ja: `pie title 売上構成比
  "製品A" : 42.5
  "製品B" : 27.3
  "製品C" : 18.2
  "その他" : 12.0`,
      en: `pie title Sales Breakdown
  "Product A" : 42.5
  "Product B" : 27.3
  "Product C" : 18.2
  "Others" : 12.0`,
    },
  },
  {
    labelKey: "mermaid.mindmap",
    code: {
      ja: `mindmap
  root((プロジェクト))
    目標
      売上向上
      コスト削減
    課題
      リソース不足
      スケジュール遅延
    解決策
      人員補充
      外部委託
      工程見直し`,
      en: `mindmap
  root((Project))
    Goals
      Increase Revenue
      Reduce Costs
    Challenges
      Resource Shortage
      Schedule Delay
    Solutions
      Hire Staff
      Outsourcing
      Process Review`,
    },
  },
  {
    labelKey: "mermaid.journey",
    code: {
      ja: `journey
  title ユーザー登録フロー
  section 登録
    トップページ訪問: 5: ユーザー
    登録フォーム入力: 3: ユーザー
    確認メール受信: 4: ユーザー
  section 初期設定
    プロフィール設定: 3: ユーザー
    チュートリアル完了: 4: ユーザー
  section 利用開始
    初回操作: 5: ユーザー`,
      en: `journey
  title User Registration Flow
  section Registration
    Visit Landing Page: 5: User
    Fill Registration Form: 3: User
    Receive Confirmation Email: 4: User
  section Setup
    Configure Profile: 3: User
    Complete Tutorial: 4: User
  section Getting Started
    First Action: 5: User`,
    },
  },
  {
    labelKey: "mermaid.gitGraph",
    code: {
      ja: `gitGraph
  commit id: "初期コミット"
  branch develop
  checkout develop
  commit id: "機能A開発"
  commit id: "機能A完了"
  checkout main
  merge develop id: "機能Aマージ"
  branch feature-b
  checkout feature-b
  commit id: "機能B開発"
  checkout develop
  commit id: "バグ修正"
  checkout main
  merge develop id: "バグ修正マージ"
  checkout feature-b
  commit id: "機能B完了"
  checkout main
  merge feature-b id: "機能Bマージ"`,
      en: `gitGraph
  commit id: "Initial commit"
  branch develop
  checkout develop
  commit id: "Feature A dev"
  commit id: "Feature A done"
  checkout main
  merge develop id: "Merge feature A"
  branch feature-b
  checkout feature-b
  commit id: "Feature B dev"
  checkout develop
  commit id: "Bug fix"
  checkout main
  merge develop id: "Merge bug fix"
  checkout feature-b
  commit id: "Feature B done"
  checkout main
  merge feature-b id: "Merge feature B"`,
    },
  },
  {
    labelKey: "mermaid.timeline",
    code: {
      ja: `timeline
  title 製品ロードマップ
  section 2025年 第1四半期
    1月 : 要件定義
        : チーム編成
    2月 : プロトタイプ開発
    3月 : ユーザーテスト
  section 2025年 第2四半期
    4月 : ベータ版リリース
    5月 : フィードバック対応
    6月 : 正式リリース`,
      en: `timeline
  title Product Roadmap
  section 2025 Q1
    January : Requirements Definition
            : Team Formation
    February : Prototype Development
    March : User Testing
  section 2025 Q2
    April : Beta Release
    May : Feedback Response
    June : Official Release`,
    },
  },
  {
    labelKey: "mermaid.xyChart",
    code: {
      ja: `xychart-beta
  title "月別売上推移"
  x-axis ["1月", "2月", "3月", "4月", "5月", "6月"]
  y-axis "売上（万円）" 0 --> 500
  bar [120, 180, 250, 310, 280, 420]
  line [120, 180, 250, 310, 280, 420]`,
      en: `xychart-beta
  title "Monthly Sales Trend"
  x-axis ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
  y-axis "Sales (k)" 0 --> 500
  bar [120, 180, 250, 310, 280, 420]
  line [120, 180, 250, 310, 280, 420]`,
    },
  },
  {
    labelKey: "mermaid.block",
    code: {
      ja: `block-beta
  columns 3
  アプリ層:3
    block:app:3
      columns 3
      Web["Webアプリ"] モバイル["モバイルアプリ"] CLI["CLIツール"]
    end
  API層:3
    block:api:3
      columns 2
      REST["REST API"] GraphQL["GraphQL"]
    end
  データ層:3
    block:data:3
      columns 3
      DB[("データベース")] Cache[("キャッシュ")] Storage[("ストレージ")]
    end

  Web --> REST
  モバイル --> GraphQL
  CLI --> REST
  REST --> DB
  GraphQL --> DB
  REST --> Cache
  GraphQL --> Cache`,
      en: `block-beta
  columns 3
  AppLayer:3
    block:app:3
      columns 3
      Web["Web App"] Mobile["Mobile App"] CLI["CLI Tool"]
    end
  APILayer:3
    block:api:3
      columns 2
      REST["REST API"] GraphQL["GraphQL"]
    end
  DataLayer:3
    block:data:3
      columns 3
      DB[("Database")] Cache[("Cache")] Storage[("Storage")]
    end

  Web --> REST
  Mobile --> GraphQL
  CLI --> REST
  REST --> DB
  GraphQL --> DB
  REST --> Cache
  GraphQL --> Cache`,
    },
  },
  {
    labelKey: "mermaid.packet",
    code: {
      ja: `packet-beta
  0-15: "送信元ポート"
  16-31: "宛先ポート"
  32-63: "シーケンス番号"
  64-95: "確認応答番号"
  96-99: "データオフセット"
  100-105: "予約"
  106-111: "フラグ"
  112-127: "ウィンドウサイズ"
  128-143: "チェックサム"
  144-159: "緊急ポインタ"`,
      en: `packet-beta
  0-15: "Source Port"
  16-31: "Destination Port"
  32-63: "Sequence Number"
  64-95: "Acknowledgment Number"
  96-99: "Data Offset"
  100-105: "Reserved"
  106-111: "Flags"
  112-127: "Window Size"
  128-143: "Checksum"
  144-159: "Urgent Pointer"`,
    },
  },
  {
    labelKey: "mermaid.kanban",
    code: {
      ja: `kanban
  未着手
    タスクA["UI設計"]@{ priority: 'High' }
    タスクB["API仕様書作成"]@{ priority: 'Medium' }
  進行中
    タスクC["認証機能開発"]@{ priority: 'High' }
    タスクD["テストケース作成"]@{ priority: 'Low' }
  レビュー
    タスクE["DB設計レビュー"]@{ priority: 'Medium' }
  完了
    タスクF["要件定義"]@{ priority: 'High' }`,
      en: `kanban
  Todo
    task1["UI Design"]@{ priority: 'High' }
    task2["API Spec"]@{ priority: 'Medium' }
  In Progress
    task3["Auth Feature Dev"]@{ priority: 'High' }
    task4["Write Test Cases"]@{ priority: 'Low' }
  Review
    task5["DB Design Review"]@{ priority: 'Medium' }
  Done
    task6["Requirements"]@{ priority: 'High' }`,
    },
  },
];

export const COMMIT_MESSAGE_PROMPT =
  "You are a commit message generator. " +
  "Based on the staged diff and recent commit history provided, generate a concise and descriptive commit message. " +
  "Follow the style of the recent commits if available. " +
  "Output ONLY the commit message, no explanations or code fences.";
