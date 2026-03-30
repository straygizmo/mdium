# Video Quality Improvement Design

## Overview

open-motionによるビデオ生成の品質を3つの軸で改善する:
1. フォントサイズの拡大と解像度ベースの自動スケーリング
2. アニメーションの強化（プロフェッショナルなプレゼン風）
3. 字幕システムの再設計（セグメント単位の音声生成+編集可能なナレーション）

## 1. フォントサイズ・レイアウト改善

### 解像度ベースのスケーリング

基準解像度を1920x1080とし、実際の解像度との比率で全サイズを自動スケーリングする。

**スケールファクター:** `Math.min(width / 1920, height / 1080)`

例:
- 1920x1080 → scale 1.0
- 3840x2160 (4K) → scale 2.0
- 1280x720 → scale 0.67
- 1080x1920 (縦型) → scale 0.5625（幅基準で縮小）

### 基準フォントサイズ（1920x1080時）

| 要素 | 変更前 | 変更後 |
|------|--------|--------|
| H1 | 56px | 112px |
| H2 | 42px | 84px |
| H3 | 32px | 64px |
| 本文/箇条書き | 24px | 48px |
| テーブル | 20px | 40px |
| コードブロック | 18px | 36px |
| 字幕 | 28px | 48px |

### レイアウト調整（基準値、スケーリング適用）

- シーンパディング: 60px 80px → 80px 120px
- 要素間ギャップ: 24px → 40px
- 箇条書き左マージン: 32px → 48px
- 行間: 見出し 1.2、本文 1.6、字幕 1.4（明示的指定）

### 変更ファイル

- `src/features/video/lib/scene-to-composition.tsx` — スケールファクター算出、全スタイル値に適用

## 2. アニメーション強化

プロフェッショナル・企業プレゼン風の落ち着いた動きを目指す。

### A. トランジション改善

- デフォルト時間: 15フレーム → 30フレーム (1秒 @ 30fps)
- イージング: linear → `inOut`（滑らかな加減速）
- フェードトランジションにスケール変化追加（0.95→1.0で奥行き感）

### B. 要素出現アニメーション改善

- フェードイン時間: 20フレーム → 30フレーム (1秒)
- スタガー遅延: 10フレーム → 20フレーム
- スライドイン距離: 40px → 60px
- イージング: `outCubic`（最初速く、最後ゆっくり減速）

### C. サトルモーション（出現後の持続的な動き）

- **テキスト要素:** 出現後にゆっくりfloat（translateY ±3px、周期4秒）— 静止画感を軽減
- **画像:** Ken Burns効果を強化（scale 1.0→1.05 + ゆっくりパン、シーン全体にわたる）

### D. 箇条書きアニメーション

- delayPerItem: 30フレーム → 20フレーム
- 各アイテムにフェードイン+左からスライドイン追加

### E. スコープ外

新規アニメーション種別の追加は行わない。既存の種別（fade-in, slide-in, zoom-in等）のパラメータ調整で品質向上を狙う。

### 変更ファイル

- `src/features/video/lib/scene-to-composition.tsx` — アニメーションパラメータ変更、サトルモーション追加

## 3. 字幕システム再設計

### A. ナレーション分割ロジック

ナレーションテキストを「句点（。）」と「改行（\n）」で分割し、各セグメントが1字幕・1音声ファイルに対応する。

例: 3文のナレーション → `scene_01_01.wav`, `scene_01_02.wav`, `scene_01_03.wav`

### B. 字幕テキスト生成の変更

- **廃止:** VOICEVOXモーラデータ（カタカナ）からの字幕生成
- **変更後:** 分割した元のナレーションテキストをそのまま字幕に使用
- SRT生成: 各セグメントのWAV長さを積算してタイミングを算出

### C. シーン音声の構成

- 各セグメントWAVを順番にフレームオフセットで連結再生
- シーンの`durationInFrames`: 全セグメントWAV合計長 + バッファ15フレーム
- `narrationAudio`フィールドを廃止し、セグメント配列に移行

### D. 型定義の変更

```typescript
// types.ts に追加
interface NarrationSegment {
  text: string;           // 字幕テキスト（元のナレーションテキスト）
  audioPath?: string;     // "audio/scene_01_01.wav"
  durationMs?: number;    // WAVの長さ（ミリ秒）
}

// Scene型の変更
interface Scene {
  // ...既存フィールド
  narration: string;                     // 全文（編集用、句点/改行で区切り）
  narrationSegments?: NarrationSegment[];  // 分割後のセグメント
  // narrationAudio: string は廃止 → segments に移行
}
```

### E. UI変更（ナレーション編集）

- ナレーションのテキストボックスを複数行入力可能に（改行=分割点）
- 編集後に「音声再生成」ボタンで該当シーンのTTSを再実行
- 各セグメントの字幕プレビューをリスト表示

### 変更ファイル

- `src/features/video/types.ts` — NarrationSegment型追加、Scene型変更
- `src/features/video/lib/tts-provider.ts` — セグメント単位でsynthesizeを呼ぶ
- `src/features/video/lib/srt-generator.ts` — NarrationSegment[]からSRT生成に変更
- `src/features/video/hooks/useVideoGeneration.ts` — 分割ロジック、セグメント単位の音声生成
- `src/features/video/lib/scene-to-composition.tsx` — セグメント音声の連結再生、字幕表示
- `src/features/video/lib/merge-project.ts` — narrationSegmentsのマージ対応
- ビデオパネルUIコンポーネント — ナレーション編集テキストエリア+再生成ボタン

## 後方互換性

- 既存の`.video.json`に`narrationAudio`がある場合、マイグレーション処理で`narrationSegments`に変換する
- `narrationSegments`が未定義の場合は従来の`narrationAudio`にフォールバック
- `merge-project.ts`で既存プロジェクトとの互換を維持
