# 画像トリミング／リサイズ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画像編集ビューに、元解像度を基準とした矩形トリミングと数値指定リサイズを追加する。

**Architecture:** Fabric.js キャンバスの座標系を「元画像の実ピクセル」に合わせる（背景画像 scale=1、コンテナへのフィットは `viewportTransform` のズームで行い、canvas 要素サイズはフィット表示サイズに保つ）。トリミング・リサイズはオフスクリーン canvas で実ピクセル基準の新背景を生成し、注釈オブジェクトを平行移動／比例スケールして差し替える。永続化は crop/resize 適用時に `imageBlobUrl` を新画像へ差し替え、自己編集由来の再読込はガードで抑止する。

**Tech Stack:** React 18 + TypeScript、Fabric.js v6、Zustand（tab-store / dialog-store）、react-i18next、Vitest（node 環境）、Tauri plugin-fs。

## Global Constraints

- UI 文言のハードコード禁止。すべて i18n（namespace `imageEditor`、ファイル `src/shared/i18n/locales/{ja,en}/image-editor.json`）経由。
- コード内コメントは英語で記述。
- Vitest のデフォルト環境は node（jsdom/canvas なし）。Fabric/DOM 依存コードはユニットテスト不可 → 純粋ロジックのみ抽出してテストし、Fabric 部分は手動検証チェックリストで担保。
- トリミング・リサイズはラスタ操作。SVG タブ（`isSvg`）では両機能を非表示。
- リサイズ寸法は 1〜10000 の整数。
- テスト実行: `npm test`（= `vitest run`）。
- 既存パターン踏襲：features 配下に `lib/` `hooks/` `components/`。i18n キー追加は ja/en 両方必須。
- プラン/スペック保存先は `.superpowers/`（プロジェクト規約により `docs/superpowers/` ではない）。

---

## File Structure

- Create: `src/features/image/lib/image-transform.ts` — 純粋ロジック（フィットズーム計算、リサイズ入力検証、アスペクト追従、プリセット倍率）。
- Create: `src/features/image/lib/__tests__/image-transform.test.ts` — 上記のユニットテスト。
- Modify: `src/features/image/hooks/useImageCanvas.ts` — 座標系移行、undo 拡張、crop/resize 適用、API 追加。
- Create: `src/features/image/components/ResizeDialog.tsx` — リサイズ用モーダル（AppDialog.css 流用）。
- Create: `src/features/image/components/ResizeDialog.css` — 専用スタイル（最小限）。
- Modify: `src/features/image/components/ImageCanvas.tsx` — crop 確定バー、ResizeDialog ホスト、自己編集ガード、新コールバック配線。
- Modify: `src/features/image/components/ImagePreviewToolbar.tsx` — crop ツール＋リサイズボタン追加。
- Modify: `src/stores/tab-store.ts` — `updateImageBlobUrl` アクション追加。
- Modify: `src/app/App.tsx` — `onImageReplaced` 配線（blob URL 差し替え）。
- Modify: `src/shared/i18n/locales/ja/image-editor.json` / `.../en/image-editor.json` — 文言追加。

---

### Task 1: 純粋ロジック（image-transform）

**Files:**
- Create: `src/features/image/lib/image-transform.ts`
- Test: `src/features/image/lib/__tests__/image-transform.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `computeFitZoom(containerW: number, containerH: number, imgW: number, imgH: number): number`
  - `validateResizeInput(width: number, height: number, min?: number, max?: number): boolean`
  - `followAspect(dim: "w" | "h", value: number, baseW: number, baseH: number): { width: number; height: number }`
  - `presetDimensions(baseW: number, baseH: number, percent: number): { width: number; height: number }`
  - `export const RESIZE_MIN = 1`, `export const RESIZE_MAX = 10000`

- [ ] **Step 1: Write the failing test**

Create `src/features/image/lib/__tests__/image-transform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  computeFitZoom,
  validateResizeInput,
  followAspect,
  presetDimensions,
  RESIZE_MIN,
  RESIZE_MAX,
} from "../image-transform";

describe("computeFitZoom", () => {
  it("scales a large image down to fit the container", () => {
    expect(computeFitZoom(800, 600, 1600, 1200)).toBeCloseTo(0.5);
  });
  it("never upscales beyond 1 for a small image", () => {
    expect(computeFitZoom(800, 600, 100, 100)).toBe(1);
  });
  it("uses the smaller axis ratio", () => {
    // width ratio 0.5, height ratio 0.25 -> min = 0.25
    expect(computeFitZoom(800, 300, 1600, 1200)).toBeCloseTo(0.25);
  });
  it("returns 1 for non-positive image dimensions", () => {
    expect(computeFitZoom(800, 600, 0, 0)).toBe(1);
  });
});

describe("validateResizeInput", () => {
  it("accepts integers within range", () => {
    expect(validateResizeInput(800, 600)).toBe(true);
    expect(validateResizeInput(RESIZE_MIN, RESIZE_MAX)).toBe(true);
  });
  it("rejects below min, above max, zero, negative", () => {
    expect(validateResizeInput(0, 600)).toBe(false);
    expect(validateResizeInput(800, RESIZE_MAX + 1)).toBe(false);
    expect(validateResizeInput(-5, 600)).toBe(false);
  });
  it("rejects non-integers and NaN", () => {
    expect(validateResizeInput(800.5, 600)).toBe(false);
    expect(validateResizeInput(NaN, 600)).toBe(false);
  });
});

describe("followAspect", () => {
  it("derives height from width keeping the ratio", () => {
    expect(followAspect("w", 800, 1600, 1200)).toEqual({ width: 800, height: 600 });
  });
  it("derives width from height keeping the ratio", () => {
    expect(followAspect("h", 300, 1600, 1200)).toEqual({ width: 400, height: 300 });
  });
  it("rounds to integers", () => {
    expect(followAspect("w", 100, 333, 1000)).toEqual({ width: 100, height: 300 });
  });
});

describe("presetDimensions", () => {
  it("computes a percentage of the base size, rounded", () => {
    expect(presetDimensions(1600, 1200, 50)).toEqual({ width: 800, height: 600 });
    expect(presetDimensions(1601, 1200, 50)).toEqual({ width: 801, height: 600 });
    expect(presetDimensions(800, 600, 200)).toEqual({ width: 1600, height: 1200 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- image-transform`
Expected: FAIL — cannot resolve `../image-transform` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/features/image/lib/image-transform.ts`:

```ts
// Pure, DOM-free helpers for image crop/resize math. Unit-testable in node.

export const RESIZE_MIN = 1;
export const RESIZE_MAX = 10000;

/**
 * Zoom factor that fits an image into a container without upscaling.
 * Returns 1 when image dimensions are non-positive (defensive).
 */
export function computeFitZoom(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number,
): number {
  if (imgW <= 0 || imgH <= 0) return 1;
  return Math.min(containerW / imgW, containerH / imgH, 1);
}

/** True when both dimensions are integers within [min, max]. */
export function validateResizeInput(
  width: number,
  height: number,
  min: number = RESIZE_MIN,
  max: number = RESIZE_MAX,
): boolean {
  const ok = (v: number) => Number.isInteger(v) && v >= min && v <= max;
  return ok(width) && ok(height);
}

/** Given a changed dimension, return both dimensions preserving the base aspect ratio. */
export function followAspect(
  dim: "w" | "h",
  value: number,
  baseW: number,
  baseH: number,
): { width: number; height: number } {
  if (dim === "w") {
    return { width: value, height: Math.round((value * baseH) / baseW) };
  }
  return { width: Math.round((value * baseW) / baseH), height: value };
}

/** Scale the base size by a percentage, rounded to integers. */
export function presetDimensions(
  baseW: number,
  baseH: number,
  percent: number,
): { width: number; height: number } {
  return {
    width: Math.round((baseW * percent) / 100),
    height: Math.round((baseH * percent) / 100),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- image-transform`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/features/image/lib/image-transform.ts src/features/image/lib/__tests__/image-transform.test.ts
git commit -m "feat(image): add pure crop/resize math helpers"
```

---

### Task 2: 座標系を実ピクセルへ移行

canvas 内部のシーン座標＝元画像の実ピクセルにする。canvas **要素**サイズはフィット表示サイズ（`naturalW * fitZoom`）に保ち、`viewportTransform` のズームでシーンを要素内に収める。これにより crop/resize/保存がすべて実解像度で動く。

**Files:**
- Modify: `src/features/image/hooks/useImageCanvas.ts`

**Interfaces:**
- Consumes: `computeFitZoom` (Task 1)
- Produces（hook の戻り値に追加 / 変更）:
  - `refit(): void` — 現在の自然サイズでフィット表示を再計算
  - `getNaturalSize(): { w: number; h: number } | null`
  - `getCanvasDataUrl` の region 引数はシーン（実ピクセル）座標として扱う

- [ ] **Step 1: Add a natural-size ref and import the helper**

`useImageCanvas.ts` 冒頭の import に追加：

```ts
import { computeFitZoom } from "../lib/image-transform";
```

`ocrRect` ref 付近に自然サイズ ref を追加：

```ts
// Scene coordinate space equals the original image's pixel size.
const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
```

- [ ] **Step 2: Add `fitToContainer` / `refit` and `getNaturalSize`**

`resetZoom` の定義の直後に追加：

```ts
// Size the canvas ELEMENT to the fit-display size and apply a viewport zoom
// that maps the natural-size scene into that element. Scene coords stay at
// real pixels; only the display is scaled.
const fitToContainer = useCallback(() => {
  const c = canvasRef.current;
  const container = containerRef.current;
  const nat = naturalSizeRef.current;
  if (!c || !container || !nat) return;
  const zoom = computeFitZoom(container.clientWidth, container.clientHeight, nat.w, nat.h);
  c.setDimensions({ width: Math.round(nat.w * zoom), height: Math.round(nat.h * zoom) });
  c.setViewportTransform([zoom, 0, 0, zoom, 0, 0]);
  setZoomLevel(zoom);
}, []);

const refit = useCallback(() => { fitToContainer(); }, [fitToContainer]);

const getNaturalSize = useCallback(() => naturalSizeRef.current, []);
```

- [ ] **Step 3: Change `resetZoom` to fit instead of identity**

`resetZoom` の本体を差し替え：

```ts
const resetZoom = useCallback(() => {
  fitToContainer();
}, [fitToContainer]);
```

（`fitToContainer` を `resetZoom` より前に定義する必要があるため、Step 2 のブロックを `resetZoom` の **前** に移動して配置すること。順序：`zoomOut` → `fitToContainer/refit/getNaturalSize` → `resetZoom`。）

- [ ] **Step 4: Rewrite `loadBackgroundImage` for scene=natural**

`loadBackgroundImage` の本体を差し替え：

```ts
const loadBackgroundImage = useCallback(async (url: string, savedCanvasJson?: string) => {
  const c = canvasRef.current;
  const container = containerRef.current;
  if (!c || !container) return;

  c.clear();
  undoStack.current = [];
  redoStack.current = [];
  setCanUndo(false);
  setCanRedo(false);

  const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
  naturalSizeRef.current = { w: img.width!, h: img.height! };

  // Background occupies the scene at real-pixel scale.
  img.set({
    scaleX: 1, scaleY: 1, left: 0, top: 0,
    originX: "left", originY: "top",
    selectable: false, evented: false,
  });

  if (savedCanvasJson) {
    // Objects are stored in scene (real-pixel) coordinates; background excluded.
    try {
      await c.loadFromJSON(savedCanvasJson);
    } catch (e) {
      console.error("Failed to restore canvas state:", e);
    }
  }

  c.backgroundImage = img;
  fitToContainer();
  c.renderAll();
}, [fitToContainer]);
```

- [ ] **Step 5: Simplify `getCanvasDataUrl` to scene-pixel basis**

`getCanvasDataUrl` の本体を差し替え：

```ts
const getCanvasDataUrl = useCallback((region?: { left: number; top: number; width: number; height: number }) => {
  const c = canvasRef.current;
  const nat = naturalSizeRef.current;
  if (!c || !nat) return null;

  // Region is in scene (real-pixel) coordinates; background is scale 1.
  if (region) {
    const bgImg = c.backgroundImage;
    if (bgImg && bgImg instanceof fabric.FabricImage) {
      const imgEl = bgImg.getElement() as HTMLImageElement;
      const tmp = document.createElement("canvas");
      tmp.width = Math.round(region.width);
      tmp.height = Math.round(region.height);
      const ctx = tmp.getContext("2d")!;
      ctx.drawImage(
        imgEl,
        region.left, region.top, region.width, region.height,
        0, 0, region.width, region.height,
      );
      return tmp.toDataURL("image/png");
    }
  }

  // Full export at natural resolution: temporarily set element to natural size
  // with an identity viewport, export, then restore the fit display.
  const vpt = c.viewportTransform;
  const dims = { width: c.getWidth(), height: c.getHeight() };
  c.setViewportTransform([1, 0, 0, 1, 0, 0]);
  c.setDimensions({ width: nat.w, height: nat.h });
  const url = c.toDataURL({ format: "png", multiplier: 1 });
  c.setDimensions(dims);
  c.setViewportTransform(vpt);
  return url;
}, []);
```

- [ ] **Step 6: Simplify `saveImage` (download) to reuse full export**

`saveImage` の本体を差し替え（重複ロジックを `getCanvasDataUrl` に集約・DRY）：

```ts
const saveImage = useCallback(async () => {
  const dataUrl = getCanvasDataUrl();
  if (!dataUrl) return;
  const link = document.createElement("a");
  link.download = "annotated-image.png";
  link.href = dataUrl;
  link.click();
}, [getCanvasDataUrl]);
```

- [ ] **Step 7: Export the new API**

`return { ... }` ブロックに追加：

```ts
    refit,
    getNaturalSize,
```

- [ ] **Step 8: Update the ResizeObserver effect in ImageCanvas to refit (not reload)**

`ImageCanvas.tsx` の hook 分割代入に `refit` を追加し、ResizeObserver 効果を差し替え：

分割代入（`resetZoom,` の後など）に追加：
```ts
    refit,
```

ResizeObserver 効果（現行 93-105 行付近）を差し替え：
```tsx
  // Re-fit display on container resize (objects/undo preserved; no reload).
  useEffect(() => {
    const container = containerElRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (imageSrc && initialLoadDone.current) refit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [imageSrc, refit]);
```

- [ ] **Step 9: Type-check and build**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 10: Manual verification**

`npm run dev` で起動し、画像タブを開く。確認：
- 大きい画像がコンテナにフィット表示され、canvas 要素がコンテナ内に収まる（オーバーフローしない）。
- ズーム+/- と Ctrl+ホイールが動作。ズーム%表示が初期フィット値（≤100%）。
- ズームリセットでフィット表示に戻る。
- 既存の描画ツール（矩形・テキスト等）が描けて、保存（Ctrl+S）後にファイルが**元解像度**（縮小されていない）で書き出される（保存後にファイルを開いて寸法確認）。
- OCR 範囲選択が従来どおり動く。

- [ ] **Step 11: Commit**

```bash
git add src/features/image/hooks/useImageCanvas.ts src/features/image/components/ImageCanvas.tsx
git commit -m "feat(image): use real-pixel scene coordinates with viewport-fit display"
```

---

### Task 3: Undo スナップショットに寸法を含める

crop/resize は canvas 要素寸法と自然サイズを変える。undo スナップショットを `{ json, w, h }` に拡張する（`json` は従来どおり `c.toJSON()` で背景込み。背景は src（crop/resize 後は dataURL）として復元される）。復元時に自然サイズを戻してフィットし直す。

**Files:**
- Modify: `src/features/image/hooks/useImageCanvas.ts`

**Interfaces:**
- Consumes: `fitToContainer`（Task 2）, `naturalSizeRef`
- Produces:
  - `type CanvasSnapshot = { json: string; w: number; h: number }`
  - `pushUndo()` は現在の自然サイズを含むスナップショットを積む

- [ ] **Step 1: Change the undo/redo stack types**

`useImageCanvas.ts` の型・ref を変更：

```ts
// A snapshot captures objects+background (via toJSON) and the natural size,
// so crop/resize (which change dimensions) can be fully undone.
type CanvasSnapshot = { json: string; w: number; h: number };
```

`undoStack` / `redoStack` の型を差し替え：
```ts
const undoStack = useRef<CanvasSnapshot[]>([]);
const redoStack = useRef<CanvasSnapshot[]>([]);
```

- [ ] **Step 2: Add a snapshot helper and rewrite `pushUndo`**

`pushUndo` を差し替え：

```ts
const makeSnapshot = useCallback((): CanvasSnapshot | null => {
  const c = canvasRef.current;
  const nat = naturalSizeRef.current;
  if (!c || !nat) return null;
  return { json: JSON.stringify(c.toJSON()), w: nat.w, h: nat.h };
}, []);

const pushUndo = useCallback(() => {
  if (isRestoring.current) return;
  const snap = makeSnapshot();
  if (!snap) return;
  undoStack.current.push(snap);
  if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
  redoStack.current = [];
  setCanUndo(true);
  setCanRedo(false);
}, [makeSnapshot]);
```

- [ ] **Step 3: Add a restore helper and rewrite `undo` / `redo`**

`undo` / `redo` を差し替え：

```ts
const restoreSnapshot = useCallback(async (snap: CanvasSnapshot) => {
  const c = canvasRef.current;
  if (!c) return;
  isRestoring.current = true;
  await c.loadFromJSON(snap.json);
  naturalSizeRef.current = { w: snap.w, h: snap.h };
  // Ensure the restored background is non-interactive.
  const bg = c.backgroundImage;
  if (bg) bg.set({ selectable: false, evented: false });
  fitToContainer();
  c.renderAll();
  isRestoring.current = false;
  notifyModified();
}, [fitToContainer, notifyModified]);

const undo = useCallback(() => {
  if (undoStack.current.length === 0) return;
  const current = makeSnapshot();
  if (current) redoStack.current.push(current);
  const prev = undoStack.current.pop()!;
  restoreSnapshot(prev).then(() => {
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  });
}, [makeSnapshot, restoreSnapshot]);

const redo = useCallback(() => {
  if (redoStack.current.length === 0) return;
  const current = makeSnapshot();
  if (current) undoStack.current.push(current);
  const next = redoStack.current.pop()!;
  restoreSnapshot(next).then(() => {
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  });
}, [makeSnapshot, restoreSnapshot]);
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Manual verification**

`npm run dev`：
- 画像に複数の注釈を描く → Ctrl+Z で1つずつ戻り、Ctrl+Y でやり直せる。
- 戻す/やり直しの後も背景画像が消えない（背景込み json で復元される）。
- ズーム表示が復元後もフィットを保つ。

- [ ] **Step 6: Commit**

```bash
git add src/features/image/hooks/useImageCanvas.ts
git commit -m "feat(image): capture dimensions in undo snapshots for crop/resize"
```

---

### Task 4: 永続化基盤（blob URL 差し替え＋自己編集ガード）

crop/resize の結果をタブ切替やリロード後も保持するため、適用時に `imageBlobUrl` を新画像へ差し替える。差し替えで `imageSrc` が変わると ImageCanvas の読込効果が再実行され注釈/undo が失われるため、自己編集由来の変更はガードで再読込をスキップする。

**Files:**
- Modify: `src/stores/tab-store.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/features/image/components/ImageCanvas.tsx`
- Test: `src/stores/__tests__/tab-store-image-blob.test.ts` (create)

**Interfaces:**
- Consumes: なし
- Produces:
  - tab-store: `updateImageBlobUrl(id: string, url: string): void`（旧 blob URL を revoke、`imageBlobUrl` を差し替え、`dirty: true`）
  - ImageCanvas prop: `onImageReplaced?: (blobUrl: string) => void`
  - ImageCanvas は受け取った `imageSrc` が自己編集由来なら読込をスキップする内部ガードを持つ

- [ ] **Step 1: Write the failing test for the store action**

Create `src/stores/__tests__/tab-store-image-blob.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTabStore } from "../tab-store";

describe("updateImageBlobUrl", () => {
  beforeEach(() => {
    // Reset tabs to a single image tab with a known blob url.
    useTabStore.setState({
      tabs: [
        {
          id: "t1",
          title: "img.png",
          filePath: "/img.png",
          content: "",
          dirty: false,
          imageFileType: ".png",
          imageBlobUrl: "blob:old",
        } as any,
      ],
    } as any);
  });

  it("replaces the blob url, revokes the old one, and marks dirty", () => {
    const revoke = vi.fn();
    // jsdom is not enabled; provide URL.revokeObjectURL for the test.
    (globalThis as any).URL.revokeObjectURL = revoke;

    useTabStore.getState().updateImageBlobUrl("t1", "blob:new");

    const tab = useTabStore.getState().tabs.find((t) => t.id === "t1")!;
    expect(tab.imageBlobUrl).toBe("blob:new");
    expect(tab.dirty).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:old");
  });

  it("does nothing for an unknown tab id", () => {
    expect(() => useTabStore.getState().updateImageBlobUrl("missing", "blob:x")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tab-store-image-blob`
Expected: FAIL — `updateImageBlobUrl is not a function`.

- [ ] **Step 3: Declare the action in the store type**

`tab-store.ts` の `updateImageCanvasState` 型宣言（86 行付近）の直後に追加：

```ts
  updateImageBlobUrl: (id: string, url: string) => void;
```

- [ ] **Step 4: Implement the action**

`tab-store.ts` の `updateImageCanvasState` 実装（266-272 行付近）の直後に追加：

```ts
  updateImageBlobUrl: (id, url) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        // Revoke the previous object URL to avoid leaks (no-op for data URLs).
        if (t.imageBlobUrl && t.imageBlobUrl !== url && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(t.imageBlobUrl);
        }
        return { ...t, imageBlobUrl: url, dirty: true };
      }),
    }));
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tab-store-image-blob`
Expected: PASS.

- [ ] **Step 6: Add the self-edit guard + `onImageReplaced` prop in ImageCanvas**

`ImageCanvas.tsx` の props interface に追加：

```ts
  onImageReplaced?: (blobUrl: string) => void;
```

コンポーネント引数の分割代入に `onImageReplaced` を追加。

`prevUrlRef` の付近に自己編集 ref を追加：

```ts
  // When we replace the image via crop/resize, the new imageSrc flows back in.
  // Skip the reload for that self-initiated change so annotations/undo survive.
  const selfEditUrlRef = useRef<string | null>(null);
```

背景読込効果（80-91 行付近）の冒頭にガードを追加：

```tsx
  useEffect(() => {
    if (imageSrc && imageSrc === selfEditUrlRef.current) {
      // Self-initiated replacement: canvas already reflects it.
      prevUrlRef.current = imageSrc;
      selfEditUrlRef.current = null;
      return;
    }
    if (imageSrc && imageSrc !== prevUrlRef.current) {
      prevUrlRef.current = imageSrc;
      initialLoadDone.current = false;
      loadBackgroundImage(imageSrc, canvasJson).then(() => {
        initialLoadDone.current = true;
      });
    }
    return () => {
      prevUrlRef.current = null;
    };
  }, [imageSrc, loadBackgroundImage]);
```

- [ ] **Step 7: Add a helper in ImageCanvas to persist a replaced image**

ImageCanvas 内（`handleImageCanvasModified` 相当のコールバック付近、`runOcr` の前あたり）に追加。これは Task 5/6 から呼ばれる：

```tsx
  // Persist a crop/resize result: convert the data URL to a blob URL,
  // mark it as a self-edit so the reload effect skips it, then notify App.
  const persistReplacedImage = useCallback(async (dataUrl: string) => {
    const blob = await (await fetch(dataUrl)).blob();
    const blobUrl = URL.createObjectURL(blob);
    selfEditUrlRef.current = blobUrl;
    onImageReplaced?.(blobUrl);
    onCanvasModified?.();
  }, [onImageReplaced, onCanvasModified]);
```

（`onCanvasModified` は既存 prop。分割代入に含まれていなければ追加すること。）

- [ ] **Step 8: Wire `onImageReplaced` in App.tsx**

`App.tsx` の `<ImageCanvas ... />`（1141-1147 行付近）に prop を追加：

```tsx
                    onImageReplaced={(url) => {
                      if (activeTab) useTabStore.getState().updateImageBlobUrl(activeTab.id, url);
                    }}
```

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS（`persistReplacedImage` は未使用警告が出る場合があるが、Task 5 で使用。`noUnusedLocals` で失敗する場合は Task 5 とまとめてコミットするか、一時的に `void persistReplacedImage;` を置かず Step を Task 5 直前で実施）。

> 注: `tsconfig` が `noUnusedLocals: true` の場合、Step 7 の `persistReplacedImage` は Task 5 で消費されるまで未使用エラーになる。その場合は **Task 4 の Step 7 を Task 5 の Step 1 として実施**し、本タスクは Step 1-6, 8 までで一旦コミットする（`onImageReplaced` prop と guard、store アクションのみ）。

- [ ] **Step 10: Commit**

```bash
git add src/stores/tab-store.ts src/stores/__tests__/tab-store-image-blob.test.ts src/app/App.tsx src/features/image/components/ImageCanvas.tsx
git commit -m "feat(image): persist replaced image via blob url with self-edit guard"
```

---

### Task 5: トリミング（crop）ツール

矩形を引いて（ハンドルで調整可）「適用」で実ピクセル基準に切り抜く。

**Files:**
- Modify: `src/features/image/hooks/useImageCanvas.ts`
- Modify: `src/features/image/components/ImagePreviewToolbar.tsx`
- Modify: `src/features/image/components/ImageCanvas.tsx`
- Modify: `src/shared/i18n/locales/ja/image-editor.json`, `.../en/image-editor.json`

**Interfaces:**
- Consumes: `pushUndo`, `fitToContainer`, `naturalSizeRef`, `persistReplacedImage`（Task 4）
- Produces:
  - `ImageTool` に `"crop"` を追加
  - hook: `cropActive: boolean`（選択矩形があるか）, `applyCrop(): Promise<string | null>`（cropped dataURL を返す／無効時 null）, `cancelCrop(): void`

- [ ] **Step 1: Add `"crop"` to the tool union and a crop-rect ref**

`useImageCanvas.ts`：

```ts
export type ImageTool = "select" | "text" | "rect" | "circle" | "arrow" | "line" | "pen" | "ocr" | "crop";
```

`ocrRect` ref の下に追加：

```ts
const cropRect = useRef<fabric.Rect | null>(null);
const [cropActive, setCropActive] = useState(false);
```

- [ ] **Step 2: Draw the crop selection in the tool effect**

ツール切替効果内、OCR 矩形を削除する箇所の近くで、ツール変更時に crop 矩形も掃除する。`if (ocrRect.current) {...}` ブロックの直後に追加：

```ts
    if (cropRect.current && activeTool !== "crop") {
      c.remove(cropRect.current);
      cropRect.current = null;
      setCropActive(false);
      c.renderAll();
    }
```

`handleMouseDown` 内、OCR 分岐（`if (activeTool === "ocr") {...}`）の直後に crop 分岐を追加：

```ts
      if (activeTool === "crop") {
        if (cropRect.current) {
          c.remove(cropRect.current);
          cropRect.current = null;
        }
        const rect = new fabric.Rect({
          left: pointer.x, top: pointer.y, width: 0, height: 0,
          originX: "left", originY: "top",
          fill: "rgba(0, 120, 255, 0.12)", stroke: "#0078ff", strokeWidth: 2,
          strokeDashArray: [6, 3],
          selectable: true, evented: true,
        });
        c.add(rect);
        cropRect.current = rect;
        drawingObj.current = rect;
        setCropActive(true);
        return;
      }
```

`handleMouseUp` 内、OCR 分岐（`if (activeTool === "ocr" && ...)`）の直後に追加：

```ts
      if (activeTool === "crop" && obj instanceof fabric.Rect) {
        // Keep the rectangle interactive so the user can adjust it via handles.
        c.setActiveObject(obj);
        drawingObj.current = null;
        c.renderAll();
        return;
      }
```

- [ ] **Step 3: Implement `applyCrop` / `cancelCrop`**

`deleteSelected` の定義の直後に追加：

```ts
const cancelCrop = useCallback(() => {
  const c = canvasRef.current;
  if (c && cropRect.current) {
    c.remove(cropRect.current);
    cropRect.current = null;
    c.renderAll();
  }
  setCropActive(false);
  setActiveTool("select");
}, []);

const applyCrop = useCallback(async (): Promise<string | null> => {
  const c = canvasRef.current;
  const rect = cropRect.current;
  const nat = naturalSizeRef.current;
  if (!c || !rect || !nat) return null;

  // Crop rectangle bounds in scene (real-pixel) coordinates, clamped to image.
  const rw = (rect.width ?? 0) * (rect.scaleX ?? 1);
  const rh = (rect.height ?? 0) * (rect.scaleY ?? 1);
  let left = Math.max(0, Math.round(rect.left ?? 0));
  let top = Math.max(0, Math.round(rect.top ?? 0));
  let width = Math.round(rw);
  let height = Math.round(rh);
  width = Math.min(width, nat.w - left);
  height = Math.min(height, nat.h - top);
  if (width < 1 || height < 1) return null;

  // Remove the selection rect before snapshot/crop.
  c.remove(rect);
  cropRect.current = null;
  setCropActive(false);

  pushUndo();

  const bg = c.backgroundImage as fabric.FabricImage | undefined;
  if (!bg) return null;
  const el = bg.getElement() as HTMLImageElement;
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  off.getContext("2d")!.drawImage(el, left, top, width, height, 0, 0, width, height);
  const croppedUrl = off.toDataURL("image/png");

  const newImg = await fabric.FabricImage.fromURL(croppedUrl);
  newImg.set({ scaleX: 1, scaleY: 1, left: 0, top: 0, originX: "left", originY: "top", selectable: false, evented: false });

  // Translate annotations so the cropped region becomes the new origin.
  c.getObjects().forEach((o) => {
    o.set({ left: (o.left ?? 0) - left, top: (o.top ?? 0) - top });
    o.setCoords();
  });

  naturalSizeRef.current = { w: width, h: height };
  c.backgroundImage = newImg;
  fitToContainer();
  c.renderAll();
  setActiveTool("select");
  return croppedUrl;
}, [pushUndo, fitToContainer]);
```

`return { ... }` に追加：

```ts
    cropActive,
    applyCrop,
    cancelCrop,
```

- [ ] **Step 4: Add crop to the toolbar (hidden for SVG)**

`ImagePreviewToolbar.tsx`：

`TOOL_IDS` に `"crop"` を追加：
```ts
const TOOL_IDS: ImageTool[] = [
  "select", "text", "rect", "circle", "arrow", "line", "pen", "crop", "ocr",
];
```

crop もラスタ操作なので SVG で隠す。`DRAWING_TOOLS` の下の `visibleTools` 計算を差し替え：
```ts
const RASTER_ONLY_TOOLS: ImageTool[] = ["crop"];
const hiddenForSvg = new Set<ImageTool>([...DRAWING_TOOLS, ...RASTER_ONLY_TOOLS]);
const visibleTools = isSvg ? TOOL_IDS.filter((id) => !hiddenForSvg.has(id)) : TOOL_IDS;
```

- [ ] **Step 5: Add crop apply/cancel bar in ImageCanvas**

`ImageCanvas.tsx` の hook 分割代入に追加：
```ts
    cropActive,
    applyCrop,
    cancelCrop,
```

crop 適用ハンドラを追加（`handleOcr` の近く）：
```tsx
  const handleApplyCrop = useCallback(async () => {
    const url = await applyCrop();
    if (url) await persistReplacedImage(url);
  }, [applyCrop, persistReplacedImage]);
```

ツールバーの下、`image-canvas-container` の直前に確定バーを追加：
```tsx
      {activeTool === "crop" && cropActive && (
        <div className="image-crop-bar">
          <span className="image-crop-hint">{t("crop.hint")}</span>
          <button className="im-tb-btn im-tb-btn--active" onClick={handleApplyCrop}>{t("crop.apply")}</button>
          <button className="im-tb-btn" onClick={cancelCrop}>{t("crop.cancel")}</button>
        </div>
      )}
```

`ImageCanvas.css` に最小スタイルを追加：
```css
.image-crop-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--toolbar-bg, #2a2a2a);
}
.image-crop-hint {
  font-size: 12px;
  opacity: 0.8;
}
```

- [ ] **Step 6: Add i18n keys**

`ja/image-editor.json` の `tools` に追加し、ルートに crop ブロックを追加：
```json
  "tools": {
    "select": "選択",
    "text": "T テキスト",
    "rect": "□ 矩形",
    "circle": "○ 円",
    "arrow": "→ 矢印",
    "line": "/ 線",
    "pen": "✎ ペン",
    "crop": "✂ トリミング",
    "ocr": "OCR 範囲選択"
  },
  "crop": {
    "hint": "範囲をドラッグして調整",
    "apply": "トリミング適用",
    "cancel": "キャンセル"
  },
```

`en/image-editor.json` 同様：
```json
  "tools": {
    "select": "Select",
    "text": "T Text",
    "rect": "□ Rectangle",
    "circle": "○ Circle",
    "arrow": "→ Arrow",
    "line": "/ Line",
    "pen": "✎ Pen",
    "crop": "✂ Crop",
    "ocr": "OCR Region"
  },
  "crop": {
    "hint": "Drag to select, adjust with handles",
    "apply": "Apply Crop",
    "cancel": "Cancel"
  },
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Manual verification**

`npm run dev`：
- 「✂ トリミング」を選択 → 画像上で矩形ドラッグ → ハンドルでサイズ調整可。
- 「トリミング適用」で画像がその範囲に切り抜かれ、注釈が正しく平行移動・クリップされる。
- 「キャンセル」で選択が消え select に戻る。
- crop 後に Ctrl+Z で元の画像・注釈・寸法に戻る。
- crop 後にタブを切り替えて戻ると crop 結果が保持される。
- crop 後に Ctrl+S → 切り抜きサイズで保存される。
- SVG タブでは「✂ トリミング」が表示されない。

- [ ] **Step 9: Commit**

```bash
git add src/features/image/hooks/useImageCanvas.ts src/features/image/components/ImagePreviewToolbar.tsx src/features/image/components/ImageCanvas.tsx src/features/image/components/ImageCanvas.css src/shared/i18n/locales/ja/image-editor.json src/shared/i18n/locales/en/image-editor.json
git commit -m "feat(image): add crop tool with real-pixel cropping"
```

---

### Task 6: リサイズ（resize）ダイアログ

ツールバーのボタンでモーダルを開き、幅・高さを数値指定して画像と注釈を比例スケールする。

**Files:**
- Create: `src/features/image/components/ResizeDialog.tsx`
- Create: `src/features/image/components/ResizeDialog.css`
- Modify: `src/features/image/hooks/useImageCanvas.ts`
- Modify: `src/features/image/components/ImagePreviewToolbar.tsx`
- Modify: `src/features/image/components/ImageCanvas.tsx`
- Modify: `src/shared/i18n/locales/ja/image-editor.json`, `.../en/image-editor.json`

**Interfaces:**
- Consumes: `validateResizeInput`, `followAspect`, `presetDimensions`, `RESIZE_MIN`, `RESIZE_MAX`（Task 1）, `pushUndo`, `fitToContainer`, `naturalSizeRef`, `getNaturalSize`, `persistReplacedImage`（Task 4）
- Produces:
  - hook: `applyResize(newW: number, newH: number): Promise<string | null>`
  - component `ResizeDialog`: props `{ initialWidth, initialHeight, onApply, onCancel }`

- [ ] **Step 1: Implement `applyResize` in the hook**

`applyCrop` の直後に追加：

```ts
const applyResize = useCallback(async (newW: number, newH: number): Promise<string | null> => {
  const c = canvasRef.current;
  const nat = naturalSizeRef.current;
  if (!c || !nat || newW < 1 || newH < 1) return null;
  const bg = c.backgroundImage as fabric.FabricImage | undefined;
  if (!bg) return null;

  pushUndo();

  const rx = newW / nat.w;
  const ry = newH / nat.h;
  const el = bg.getElement() as HTMLImageElement;
  const off = document.createElement("canvas");
  off.width = newW;
  off.height = newH;
  const ctx = off.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(el, 0, 0, el.naturalWidth || nat.w, el.naturalHeight || nat.h, 0, 0, newW, newH);
  const resizedUrl = off.toDataURL("image/png");

  const newImg = await fabric.FabricImage.fromURL(resizedUrl);
  newImg.set({ scaleX: 1, scaleY: 1, left: 0, top: 0, originX: "left", originY: "top", selectable: false, evented: false });

  // Scale annotation position and size proportionally.
  c.getObjects().forEach((o) => {
    o.set({
      left: (o.left ?? 0) * rx,
      top: (o.top ?? 0) * ry,
      scaleX: (o.scaleX ?? 1) * rx,
      scaleY: (o.scaleY ?? 1) * ry,
    });
    o.setCoords();
  });

  naturalSizeRef.current = { w: newW, h: newH };
  c.backgroundImage = newImg;
  fitToContainer();
  c.renderAll();
  return resizedUrl;
}, [pushUndo, fitToContainer]);
```

`return { ... }` に追加：
```ts
    applyResize,
```

- [ ] **Step 2: Create the ResizeDialog component**

Create `src/features/image/components/ResizeDialog.tsx`:

```tsx
import { useState, useCallback, type FC } from "react";
import { useTranslation } from "react-i18next";
import {
  validateResizeInput,
  followAspect,
  presetDimensions,
  RESIZE_MIN,
  RESIZE_MAX,
} from "../lib/image-transform";
import "./ResizeDialog.css";

interface Props {
  initialWidth: number;
  initialHeight: number;
  onApply: (width: number, height: number) => void;
  onCancel: () => void;
}

const PRESETS = [25, 50, 75, 200];

export const ResizeDialog: FC<Props> = ({ initialWidth, initialHeight, onApply, onCancel }) => {
  const { t } = useTranslation("imageEditor");
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [keepAspect, setKeepAspect] = useState(true);

  const onWidthChange = useCallback((v: number) => {
    if (keepAspect) {
      const r = followAspect("w", v, initialWidth, initialHeight);
      setWidth(r.width);
      setHeight(r.height);
    } else {
      setWidth(v);
    }
  }, [keepAspect, initialWidth, initialHeight]);

  const onHeightChange = useCallback((v: number) => {
    if (keepAspect) {
      const r = followAspect("h", v, initialWidth, initialHeight);
      setWidth(r.width);
      setHeight(r.height);
    } else {
      setHeight(v);
    }
  }, [keepAspect, initialWidth, initialHeight]);

  const applyPreset = useCallback((percent: number) => {
    const r = presetDimensions(initialWidth, initialHeight, percent);
    setWidth(r.width);
    setHeight(r.height);
  }, [initialWidth, initialHeight]);

  const valid = validateResizeInput(width, height);

  return (
    <div className="app-dialog__overlay" onMouseDown={onCancel}>
      <div className="app-dialog resize-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-dialog__title">{t("resize.title")}</div>
        <div className="resize-dialog__current">
          {t("resize.current", { width: initialWidth, height: initialHeight })}
        </div>
        <div className="resize-dialog__row">
          <label>
            {t("resize.width")}
            <input
              type="number" min={RESIZE_MIN} max={RESIZE_MAX} value={width}
              onChange={(e) => onWidthChange(Number(e.target.value))}
            />
          </label>
          <label>
            {t("resize.height")}
            <input
              type="number" min={RESIZE_MIN} max={RESIZE_MAX} value={height}
              onChange={(e) => onHeightChange(Number(e.target.value))}
            />
          </label>
        </div>
        <label className="resize-dialog__aspect">
          <input type="checkbox" checked={keepAspect} onChange={(e) => setKeepAspect(e.target.checked)} />
          {t("resize.keepAspect")}
        </label>
        <div className="resize-dialog__presets">
          <span>{t("resize.preset")}</span>
          {PRESETS.map((p) => (
            <button key={p} className="app-dialog__btn" onClick={() => applyPreset(p)}>{p}%</button>
          ))}
        </div>
        {!valid && <div className="resize-dialog__error">{t("resize.invalid")}</div>}
        <div className="app-dialog__actions">
          <button className="app-dialog__btn app-dialog__btn--primary" disabled={!valid} onClick={() => onApply(width, height)}>
            {t("resize.ok")}
          </button>
          <button className="app-dialog__btn" onClick={onCancel}>{t("resize.cancel")}</button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Create ResizeDialog.css**

Create `src/features/image/components/ResizeDialog.css`:

```css
.resize-dialog { min-width: 320px; }
.resize-dialog__current { font-size: 13px; opacity: 0.8; margin-bottom: 10px; }
.resize-dialog__row { display: flex; gap: 12px; margin-bottom: 10px; }
.resize-dialog__row label { display: flex; flex-direction: column; font-size: 12px; gap: 4px; }
.resize-dialog__row input { width: 100px; }
.resize-dialog__aspect { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-bottom: 10px; }
.resize-dialog__presets { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 10px; }
.resize-dialog__error { color: #e06c75; font-size: 12px; margin-bottom: 8px; }
```

- [ ] **Step 4: Add the resize button to the toolbar**

`ImagePreviewToolbar.tsx`：props に追加：
```ts
  onResize: () => void;
```
分割代入に `onResize` を追加。ズームコントロールの直後（`{!isSvg && (` の undo/redo ブロックの中、`onRedo` ボタンの後）にリサイズボタンを追加：
```tsx
          <span className="im-tb-sep" />
          <button className="im-tb-btn" onClick={onResize} title={t("resize.button")}>
            {t("resize.button")}
          </button>
```

- [ ] **Step 5: Host the dialog in ImageCanvas**

`ImageCanvas.tsx`：hook 分割代入に追加：
```ts
    applyResize,
    getNaturalSize,
```
state を追加（`ocrResult` 付近）：
```ts
  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizeInit, setResizeInit] = useState<{ w: number; h: number } | null>(null);
```
import を追加：
```ts
import { ResizeDialog } from "./ResizeDialog";
```
ハンドラを追加：
```tsx
  const handleOpenResize = useCallback(() => {
    const nat = getNaturalSize();
    if (!nat) return;
    setResizeInit({ w: nat.w, h: nat.h });
    setResizeOpen(true);
  }, [getNaturalSize]);

  const handleApplyResize = useCallback(async (w: number, h: number) => {
    setResizeOpen(false);
    const url = await applyResize(w, h);
    if (url) await persistReplacedImage(url);
  }, [applyResize, persistReplacedImage]);
```
ツールバーに `onResize={handleOpenResize}` を渡す。コンポーネント末尾（OCR overlay の後）にダイアログを追加：
```tsx
      {resizeOpen && resizeInit && (
        <ResizeDialog
          initialWidth={resizeInit.w}
          initialHeight={resizeInit.h}
          onApply={handleApplyResize}
          onCancel={() => setResizeOpen(false)}
        />
      )}
```

- [ ] **Step 6: Add i18n keys**

`ja/image-editor.json` のルートに追加：
```json
  "resize": {
    "button": "⤢ リサイズ",
    "title": "画像のリサイズ",
    "current": "現在: {{width}} × {{height}} px",
    "width": "幅 (px)",
    "height": "高さ (px)",
    "keepAspect": "縦横比を固定",
    "preset": "倍率:",
    "ok": "OK",
    "cancel": "キャンセル",
    "invalid": "1〜10000 の整数を入力してください。"
  },
```
`en/image-editor.json` のルートに追加：
```json
  "resize": {
    "button": "⤢ Resize",
    "title": "Resize Image",
    "current": "Current: {{width}} × {{height}} px",
    "width": "Width (px)",
    "height": "Height (px)",
    "keepAspect": "Keep aspect ratio",
    "preset": "Scale:",
    "ok": "OK",
    "cancel": "Cancel",
    "invalid": "Enter integers between 1 and 10000."
  },
```

- [ ] **Step 7: Type-check and run all tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS（型エラーなし、全テスト緑）。

- [ ] **Step 8: Manual verification**

`npm run dev`：
- 「⤢ リサイズ」ボタンでダイアログが開き、現在サイズが表示される。
- 縦横比固定 ON で幅を変えると高さが自動追従。OFF で独立に変更可。
- プリセット 25/50/75/200% がボタンで反映される。
- 範囲外（0 / 10001 / 小数）入力で OK が無効化され、エラー文言が出る。
- OK で画像と注釈が比例スケールされる（縮小・拡大とも）。
- resize 後に Ctrl+Z で元サイズに戻る。
- resize 後にタブ切替で結果が保持され、Ctrl+S で新サイズ保存。
- SVG タブではリサイズボタンが表示されない。

- [ ] **Step 9: Commit**

```bash
git add src/features/image/hooks/useImageCanvas.ts src/features/image/components/ResizeDialog.tsx src/features/image/components/ResizeDialog.css src/features/image/components/ImagePreviewToolbar.tsx src/features/image/components/ImageCanvas.tsx src/shared/i18n/locales/ja/image-editor.json src/shared/i18n/locales/en/image-editor.json
git commit -m "feat(image): add numeric resize dialog with aspect lock and presets"
```

---

## Self-Review Notes

**Spec coverage:**
- §3 実ピクセル座標系 → Task 2。
- §4 トリミング（矩形ドラッグ→適用、注釈平行移動・クリップ、SVG 非表示）→ Task 5。
- §5 リサイズダイアログ（数値入力・アスペクト固定・プリセット・バリデーション・SVG 非表示）→ Task 6 / Task 1（計算）。
- §6 Undo 拡張（寸法込みスナップショット）→ Task 3。
- §7 永続化（imageBlobUrl 差し替え、revoke、自己編集ガード）→ Task 4。
- §8 i18n → Task 5 / Task 6。
- §9 テスト方針（純粋ロジックのユニット、Fabric は手動）→ Task 1 / Task 4 ユニット、各タスクの手動検証。

**注意点（実装者向け）:**
- Task 2 の `fitToContainer` は `resetZoom` より前に定義すること（依存順）。
- Task 4 Step 9 の注記参照：`noUnusedLocals` 環境では `persistReplacedImage` を Task 5 で消費するまで未使用になるため、コミット分割を調整。
- crop/resize 後の `imageBlobUrl` 差し替えで読込効果が再実行されるが、`selfEditUrlRef` ガードで再読込はスキップされる（注釈/undo を保持）。
- undo スナップショットは背景込み `toJSON()`。crop/resize 後は背景が dataURL になりスナップショットが大きくなる。`MAX_UNDO=50` 据え置きで開始し、メモリ問題が出たらフルスナップショットの世代数を絞る（spec §6）。
