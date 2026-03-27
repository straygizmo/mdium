# Image Paste Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clipboard image paste support to the MD editor — detect images on Ctrl+V, save as PNG to `images/` subfolder, and insert a markdown image link with optional AI-generated alt text.

**Architecture:** Frontend-centric approach. The `<textarea>` `onPaste` event detects images, a modal dialog collects alt text (with AI sparkle button), and `@tauri-apps/plugin-fs` saves the file. A new Rust Tauri command `ai_chat_with_image` handles Vision API calls for AI alt text generation, sharing a helper with the existing `ai_chat` command.

**Tech Stack:** React 19 + TypeScript, Tauri 2 (Rust backend), `@tauri-apps/plugin-fs`, Zustand, react-i18next

**Spec:** `docs/superpowers/specs/2026-03-26-image-paste-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/features/editor/hooks/useImagePaste.ts` | Create | Paste event handler, image blob extraction, file saving, markdown link insertion |
| `src/features/editor/components/ImagePasteDialog.tsx` | Create | Modal dialog: image preview, alt text input, AI sparkle button, insert/cancel |
| `src/features/editor/components/ImagePasteDialog.css` | Create | Dialog styles (follows `AiGenerateModal.css` pattern) |
| `src/features/editor/components/EditorPanel.tsx` | Modify | Wire `onPaste` handler and render `ImagePasteDialog` |
| `src-tauri/src/commands/ai.rs` | Modify | Add `ai_chat_with_image` command, extract shared helpers from `ai_chat` |
| `src-tauri/src/lib.rs` | Modify | Register `ai_chat_with_image` in invoke_handler |
| `src/shared/i18n/locales/ja/editor.json` | Modify | Add image paste translation keys |
| `src/shared/i18n/locales/en/editor.json` | Modify | Add image paste translation keys |

---

### Task 1: i18n — Add Translation Keys

**Files:**
- Modify: `src/shared/i18n/locales/ja/editor.json`
- Modify: `src/shared/i18n/locales/en/editor.json`

- [ ] **Step 1: Add Japanese translation keys**

Open `src/shared/i18n/locales/ja/editor.json` and add the following entries before the closing `}`:

```json
  "imagePaste": "画像貼り付け",
  "imagePasteAlt": "alt テキスト",
  "imagePasteInsert": "挿入",
  "imagePasteAiGenerate": "AIで説明を生成",
  "imagePasteNoFile": "ファイルを保存してから画像を貼り付けてください",
  "imagePasteError": "画像の保存に失敗しました"
```

- [ ] **Step 2: Add English translation keys**

Open `src/shared/i18n/locales/en/editor.json` and add the following entries before the closing `}`:

```json
  "imagePaste": "Paste Image",
  "imagePasteAlt": "Alt text",
  "imagePasteInsert": "Insert",
  "imagePasteAiGenerate": "Generate description with AI",
  "imagePasteNoFile": "Save the file before pasting images",
  "imagePasteError": "Failed to save image"
```

- [ ] **Step 3: Verify the app still compiles**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/ja/editor.json src/shared/i18n/locales/en/editor.json
git commit -m "feat(i18n): add image paste translation keys"
```

---

### Task 2: Rust — Refactor `ai_chat` and Add `ai_chat_with_image` Command

**Files:**
- Modify: `src-tauri/src/commands/ai.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `AiChatWithImageRequest` struct**

In `src-tauri/src/commands/ai.rs`, add after the existing `AiChatRequest` struct (line 25):

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatWithImageRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub api_format: String,
    #[serde(default)]
    pub azure_api_version: String,
    pub system_prompt: String,
    pub user_message: String,
    pub image_base64: String,
}
```

- [ ] **Step 2: Extract helper structs and functions**

Add helper structs and functions above the `ai_chat` function to share logic between `ai_chat` and `ai_chat_with_image`. Extract:
- `build_client()` — creates reqwest client with timeout
- `build_request()` — builds the HTTP request per API format (URL, headers)
- `parse_response()` — parses status/body and extracts text content

```rust
struct AiEndpoint {
    url: String,
    api_format: String,
}

fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

fn build_endpoint(base_url: &str, api_format: &str, azure_api_version: &str) -> AiEndpoint {
    let url = match api_format {
        "anthropic" => format!("{}/messages", base_url.trim_end_matches('/')),
        "azure" => {
            let ver = if azure_api_version.is_empty() {
                "2024-12-01-preview"
            } else {
                azure_api_version
            };
            format!(
                "{}/chat/completions?api-version={}",
                base_url.trim_end_matches('/'),
                ver
            )
        }
        _ => format!("{}/chat/completions", base_url.trim_end_matches('/')),
    };
    AiEndpoint {
        url,
        api_format: api_format.to_string(),
    }
}

fn build_request(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    api_key: &str,
) -> reqwest::RequestBuilder {
    match endpoint.api_format.as_str() {
        "anthropic" => client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        "azure" => client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .header("api-key", api_key),
        _ => client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key)),
    }
}

async fn parse_ai_response(res: reqwest::Response, api_format: &str) -> Result<String, String> {
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        let truncated: &str = if body.len() > 500 {
            match body.char_indices().nth(500) {
                Some((idx, _)) => &body[..idx],
                None => &body,
            }
        } else {
            &body
        };
        return Err(format!("HTTP {}: {}", status, truncated));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let text = if api_format == "anthropic" {
        json["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string()
    } else {
        json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };

    Ok(text)
}
```

- [ ] **Step 3: Refactor existing `ai_chat` to use helpers**

Replace the existing `ai_chat` function body with code that uses the new helpers:

```rust
#[tauri::command]
pub async fn ai_chat(req: AiChatRequest) -> Result<String, String> {
    let client = build_client(60)?;
    let endpoint = build_endpoint(&req.base_url, &req.api_format, &req.azure_api_version);

    let body = match req.api_format.as_str() {
        "anthropic" => serde_json::json!({
            "model": req.model,
            "max_tokens": 2048,
            "system": req.system_prompt,
            "messages": [{"role": "user", "content": req.user_message}]
        }),
        "azure" => serde_json::json!({
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {"role": "user", "content": req.user_message}
            ],
            "max_completion_tokens": 2048
        }),
        _ => serde_json::json!({
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {"role": "user", "content": req.user_message}
            ],
            "max_tokens": 2048
        }),
    };

    let res = build_request(&client, &endpoint, &req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    parse_ai_response(res, &req.api_format).await
}
```

- [ ] **Step 4: Add `ai_chat_with_image` command**

Add the new command after `ai_chat`:

```rust
#[tauri::command]
pub async fn ai_chat_with_image(req: AiChatWithImageRequest) -> Result<String, String> {
    let client = build_client(60)?;
    let endpoint = build_endpoint(&req.base_url, &req.api_format, &req.azure_api_version);

    let data_url = format!("data:image/png;base64,{}", req.image_base64);

    let body = match req.api_format.as_str() {
        "anthropic" => serde_json::json!({
            "model": req.model,
            "max_tokens": 256,
            "system": req.system_prompt,
            "messages": [{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": req.image_base64
                        }
                    },
                    {"type": "text", "text": req.user_message}
                ]
            }]
        }),
        "azure" => serde_json::json!({
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": req.user_message}
                    ]
                }
            ],
            "max_completion_tokens": 256
        }),
        _ => serde_json::json!({
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": req.user_message}
                    ]
                }
            ],
            "max_tokens": 256
        }),
    };

    let res = build_request(&client, &endpoint, &req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    parse_ai_response(res, &req.api_format).await
}
```

- [ ] **Step 5: Register command in `lib.rs`**

In `src-tauri/src/lib.rs`, add `commands::ai::ai_chat_with_image` to the `invoke_handler` macro, right after `commands::ai::ai_chat` (line 99):

```rust
            commands::ai::ai_chat,
            commands::ai::ai_chat_with_image,
```

- [ ] **Step 6: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/ai.rs src-tauri/src/lib.rs
git commit -m "feat(ai): add ai_chat_with_image command with Vision API support"
```

---

### Task 3: Frontend — Create `useImagePaste` Hook

**Files:**
- Create: `src/features/editor/hooks/useImagePaste.ts`

- [ ] **Step 1: Create the hook file**

Create `src/features/editor/hooks/useImagePaste.ts` with the full implementation:

```typescript
import { useState, useCallback, useRef } from "react";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";

interface PasteDialogState {
  visible: boolean;
  imageBlob: Blob | null;
  imageUrl: string | null;
  cursorPos: number;
}

interface UseImagePasteParams {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  filePath: string | null;
  onContentChange: (newContent: string) => void;
  onNoFile: () => void;
}

function generateTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

function getDirectoryFromPath(filePath: string): string {
  // Handle both Windows backslash and Unix forward slash
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSep >= 0 ? filePath.substring(0, lastSep) : filePath;
}

export function useImagePaste({
  editorRef,
  content,
  filePath,
  onContentChange,
  onNoFile,
}: UseImagePasteParams) {
  const [pasteDialogState, setPasteDialogState] = useState<PasteDialogState>({
    visible: false,
    imageBlob: null,
    imageUrl: null,
    cursorPos: 0,
  });
  const blobUrlRef = useRef<string | null>(null);

  const cleanupBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      // Text priority: if text data exists, let default paste handle it
      const textData = e.clipboardData.getData("text/plain");
      if (textData) return;

      // Look for image data
      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          imageItem = items[i];
          break;
        }
      }

      if (!imageItem) return;

      e.preventDefault();

      if (!filePath) {
        onNoFile();
        return;
      }

      const blob = imageItem.getAsFile();
      if (!blob) return;

      // Clean up previous blob URL if any
      cleanupBlobUrl();

      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;

      const cursorPos = editorRef.current?.selectionStart ?? 0;

      setPasteDialogState({
        visible: true,
        imageBlob: blob,
        imageUrl: url,
        cursorPos,
      });
    },
    [filePath, onNoFile, editorRef, cleanupBlobUrl],
  );

  const closePasteDialog = useCallback(() => {
    cleanupBlobUrl();
    setPasteDialogState({
      visible: false,
      imageBlob: null,
      imageUrl: null,
      cursorPos: 0,
    });
  }, [cleanupBlobUrl]);

  const confirmPaste = useCallback(
    async (altText: string) => {
      if (!filePath || !pasteDialogState.imageBlob) return;

      const dirPath = getDirectoryFromPath(filePath);
      const imagesDir = `${dirPath}/images`;
      const fileName = `image-${generateTimestamp()}.png`;
      const savePath = `${imagesDir}/${fileName}`;
      const markdownLink = `![${altText}](images/${fileName})`;

      // Save image
      try {
        await mkdir(imagesDir, { recursive: true });
        const arrayBuffer = await pasteDialogState.imageBlob.arrayBuffer();
        await writeFile(savePath, new Uint8Array(arrayBuffer));
      } catch (e) {
        throw new Error(
          e instanceof Error ? e.message : String(e)
        );
      }

      // Insert markdown link at cursor position
      const pos = pasteDialogState.cursorPos;
      const newContent =
        content.substring(0, pos) + markdownLink + content.substring(pos);
      onContentChange(newContent);

      // Move cursor after inserted link
      const newPos = pos + markdownLink.length;
      setTimeout(() => {
        const textarea = editorRef.current;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(newPos, newPos);
        }
      }, 0);

      closePasteDialog();
    },
    [filePath, pasteDialogState, content, onContentChange, editorRef, closePasteDialog],
  );

  return {
    handlePaste,
    pasteDialogState,
    closePasteDialog,
    confirmPaste,
  };
}
```

- [ ] **Step 2: Verify the app compiles**

Run: `npm run build`
Expected: Build succeeds (hook not yet wired, but should compile).

- [ ] **Step 3: Commit**

```bash
git add src/features/editor/hooks/useImagePaste.ts
git commit -m "feat(editor): add useImagePaste hook for clipboard image handling"
```

---

### Task 4: Frontend — Create `ImagePasteDialog` Component

**Files:**
- Create: `src/features/editor/components/ImagePasteDialog.css`
- Create: `src/features/editor/components/ImagePasteDialog.tsx`

- [ ] **Step 1: Create the CSS file**

Create `src/features/editor/components/ImagePasteDialog.css` following the existing `AiGenerateModal.css` pattern:

```css
.image-paste-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 900;
}

.image-paste-dialog {
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  width: 420px;
  box-shadow: 0 8px 32px var(--shadow-strong);
}

.image-paste-dialog__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 12px;
}

.image-paste-dialog__preview {
  width: 100%;
  max-height: 200px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 12px;
  background: var(--bg-surface);
}

.image-paste-dialog__label {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.image-paste-dialog__input-wrap {
  display: flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-input);
}

.image-paste-dialog__input-wrap:focus-within {
  border-color: var(--primary);
}

.image-paste-dialog__input {
  flex: 1;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.image-paste-dialog__ai-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.image-paste-dialog__ai-btn:hover:not(:disabled) {
  color: var(--primary);
}

.image-paste-dialog__ai-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.image-paste-dialog__ai-btn--generating {
  animation: image-paste-spin 1s linear infinite;
}

@keyframes image-paste-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.image-paste-dialog__error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--accent-red);
}

.image-paste-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.image-paste-dialog__btn {
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}

.image-paste-dialog__btn--cancel {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text);
}

.image-paste-dialog__btn--primary {
  background: var(--primary);
  border: none;
  color: #fff;
}

.image-paste-dialog__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 2: Create the dialog component**

Create `src/features/editor/components/ImagePasteDialog.tsx`:

```typescript
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";
import "./ImagePasteDialog.css";

interface ImagePasteDialogProps {
  imageUrl: string;
  imageBlob: Blob;
  onInsert: (altText: string) => Promise<void>;
  onClose: () => void;
}

const AI_SYSTEM_PROMPTS: Record<string, string> = {
  ja: "画像のalt属性に使用する簡潔な説明を1文で返してください。",
  en: "Return a concise one-sentence description for use as an image alt attribute.",
};

const AI_USER_MESSAGES: Record<string, string> = {
  ja: "この画像を説明してください。",
  en: "Describe this image.",
};

export function ImagePasteDialog({
  imageUrl,
  imageBlob,
  onInsert,
  onClose,
}: ImagePasteDialogProps) {
  const { t } = useTranslation("editor");
  const { t: tCommon } = useTranslation("common");
  const { aiSettings, language } = useSettingsStore();

  const [altText, setAltText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAiConfig = !!(aiSettings.apiKey && aiSettings.baseUrl && aiSettings.model);

  const handleAiGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      // Convert blob to base64 using FileReader (handles large images safely)
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          // Strip "data:image/png;base64," prefix
          const base64Data = dataUrl.split(",")[1] ?? "";
          resolve(base64Data);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(imageBlob);
      });

      const systemPrompt = AI_SYSTEM_PROMPTS[language] ?? AI_SYSTEM_PROMPTS.en;
      const userMessage = AI_USER_MESSAGES[language] ?? AI_USER_MESSAGES.en;

      const result = await invoke<string>("ai_chat_with_image", {
        req: {
          baseUrl: aiSettings.baseUrl,
          apiKey: aiSettings.apiKey,
          model: aiSettings.model,
          apiFormat: aiSettings.apiFormat,
          azureApiVersion: aiSettings.azureApiVersion ?? "",
          systemPrompt,
          userMessage,
          imageBase64: base64,
        },
      });

      setAltText(result.trim());
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setGenerating(false);
    }
  }, [imageBlob, aiSettings, language]);

  const handleInsert = useCallback(async () => {
    setInserting(true);
    setError(null);
    try {
      await onInsert(altText);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setInserting(false);
    }
  }, [altText, onInsert]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !generating && !inserting) {
        e.preventDefault();
        handleInsert();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [handleInsert, onClose, generating, inserting],
  );

  return (
    <div className="image-paste-overlay" onClick={onClose}>
      <div
        className="image-paste-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h3 className="image-paste-dialog__title">{t("imagePaste")}</h3>

        <img
          className="image-paste-dialog__preview"
          src={imageUrl}
          alt="Preview"
        />

        <div className="image-paste-dialog__label">{t("imagePasteAlt")}</div>
        <div className="image-paste-dialog__input-wrap">
          <input
            className="image-paste-dialog__input"
            type="text"
            value={altText}
            onChange={(e) => setAltText(e.target.value)}
            placeholder={t("imagePasteAlt")}
            autoFocus
            disabled={generating}
          />
          <button
            className={`image-paste-dialog__ai-btn ${generating ? "image-paste-dialog__ai-btn--generating" : ""}`}
            onClick={handleAiGenerate}
            disabled={generating || !hasAiConfig}
            title={t("imagePasteAiGenerate")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth="2"
            >
              <path d="M15 19c1.2-3.678 2.526-5.005 6-6c-3.474-.995-4.8-2.322-6-6c-1.2 3.678-2.526 5.005-6 6c3.474.995 4.8 2.322 6 6Zm-8-9c.6-1.84 1.263-2.503 3-3c-1.737-.497-2.4-1.16-3-3c-.6 1.84-1.263 2.503-3 3c1.737.497 2.4 1.16 3 3Zm1.5 10c.3-.92.631-1.251 1.5-1.5c-.869-.249-1.2-.58-1.5-1.5c-.3.92-.631 1.251-1.5 1.5c.869.249 1.2.58 1.5 1.5Z" />
            </svg>
          </button>
        </div>

        {error && <div className="image-paste-dialog__error">{error}</div>}

        <div className="image-paste-dialog__actions">
          <button
            className="image-paste-dialog__btn image-paste-dialog__btn--cancel"
            onClick={onClose}
          >
            {tCommon("cancel")}
          </button>
          <button
            className="image-paste-dialog__btn image-paste-dialog__btn--primary"
            onClick={handleInsert}
            disabled={inserting || generating}
          >
            {inserting ? tCommon("loading") : t("imagePasteInsert")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify the app compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/features/editor/components/ImagePasteDialog.tsx src/features/editor/components/ImagePasteDialog.css
git commit -m "feat(editor): add ImagePasteDialog component with AI alt text generation"
```

---

### Task 5: Frontend — Wire `useImagePaste` into `EditorPanel`

**Files:**
- Modify: `src/features/editor/components/EditorPanel.tsx`

- [ ] **Step 1: Add imports**

At the top of `EditorPanel.tsx`, add these imports after the existing ones:

```typescript
import { useImagePaste } from "../hooks/useImagePaste";
import { ImagePasteDialog } from "./ImagePasteDialog";
import { message } from "@tauri-apps/plugin-dialog";
```

- [ ] **Step 2: Wire the hook**

Inside the `EditorPanel` component, after the `useEditorFormatting` hook call (line 81), add the following. Note: reuse the existing `t` from `useTranslation("editor")` at line 17.

```typescript
  const handleNoFile = useCallback(() => {
    message(t("imagePasteNoFile"), { kind: "warning" });
  }, [t]);

  const {
    handlePaste,
    pasteDialogState,
    closePasteDialog,
    confirmPaste,
  } = useImagePaste({
    editorRef,
    content,
    filePath: activeTab?.filePath ?? null,
    onContentChange: handleContentChange,
    onNoFile: handleNoFile,
  });
```

- [ ] **Step 3: Add `onPaste` to textarea**

On the `<textarea>` element (around line 321), add the `onPaste` handler:

```tsx
      <textarea
        ref={editorRef}
        className="editor-panel__textarea"
        value={content}
        onChange={handleTextareaChange}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => { handleKeyUp(e); handleCursorChange(); }}
        onSelect={handleCursorChange}
        onClick={handleCursorChange}
        onContextMenu={handleContextMenu}
        onPaste={handlePaste}
        placeholder={t("placeholder", { defaultValue: "" })}
        spellCheck={false}
      />
```

- [ ] **Step 4: Render the dialog**

After the `<EditorContextMenu>` closing tag (around line 345), add the dialog:

```tsx
      {pasteDialogState.visible && pasteDialogState.imageBlob && pasteDialogState.imageUrl && (
        <ImagePasteDialog
          imageUrl={pasteDialogState.imageUrl}
          imageBlob={pasteDialogState.imageBlob}
          onInsert={confirmPaste}
          onClose={closePasteDialog}
        />
      )}
```

- [ ] **Step 5: Verify the full app compiles**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/editor/components/EditorPanel.tsx
git commit -m "feat(editor): wire image paste into EditorPanel"
```

---

### Task 6: Manual Testing

- [ ] **Step 1: Start the dev server**

Run: `npm run tauri dev`

- [ ] **Step 2: Test text paste still works**

1. Copy text to clipboard
2. Paste with Ctrl+V in the editor
3. Expected: Text is pasted normally, no dialog appears

- [ ] **Step 3: Test image paste on unsaved file**

1. Open a new unsaved tab (no filePath)
2. Copy a screenshot to clipboard (PrintScreen or Snipping Tool)
3. Paste with Ctrl+V
4. Expected: Warning dialog appears saying "ファイルを保存してから画像を貼り付けてください"

- [ ] **Step 4: Test image paste on saved file**

1. Open or save an .md file
2. Copy a screenshot to clipboard
3. Paste with Ctrl+V
4. Expected: ImagePasteDialog appears with image preview

- [ ] **Step 5: Test insert without alt text**

1. With the dialog open, click "挿入" without typing alt text
2. Expected: `![](images/image-YYYYMMDD-HHmmss.png)` is inserted at cursor
3. Verify `images/` folder is created next to the .md file
4. Verify the PNG file exists and is valid

- [ ] **Step 6: Test insert with alt text**

1. Paste another image, type "テスト画像" as alt text
2. Click "挿入"
3. Expected: `![テスト画像](images/image-YYYYMMDD-HHmmss.png)` is inserted

- [ ] **Step 7: Test AI alt text generation (if AI configured)**

1. Paste an image
2. Click the sparkle button
3. Expected: Loading animation, then alt text appears in the input field
4. Click "挿入"
5. Expected: The AI-generated alt text is used in the markdown link

- [ ] **Step 8: Test keyboard shortcuts**

1. Paste an image
2. Press Escape → dialog closes, nothing inserted
3. Paste again, type alt text, press Enter → image inserted

- [ ] **Step 9: Test cancel**

1. Paste an image, click "キャンセル"
2. Expected: Dialog closes, no file saved, no text inserted

- [ ] **Step 10: Commit final state**

If all tests pass and any fixes were needed:

```bash
git add -A
git commit -m "fix(editor): polish image paste feature after manual testing"
```
