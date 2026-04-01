# Medium Direct Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to publish Markdown articles as drafts to Medium.com via the toolbar command dropdown, with automatic local image uploading.

**Architecture:** Rust backend handles all Medium API calls (via `reqwest`), frontend handles Markdown→HTML conversion (via `marked`) and orchestrates the publish flow. A modal dialog lets users confirm/edit metadata parsed from YAML frontmatter before posting.

**Tech Stack:** Tauri 2, Rust (`reqwest` with `multipart`), React 19, TypeScript, Zustand, i18next

---

### Task 1: Add i18n keys for Medium feature

**Files:**
- Modify: `src/shared/i18n/locales/ja/settings.json`
- Modify: `src/shared/i18n/locales/en/settings.json`
- Modify: `src/shared/i18n/locales/ja/editor.json`
- Modify: `src/shared/i18n/locales/en/editor.json`

- [ ] **Step 1: Add Medium keys to ja/settings.json**

Add before the closing `}`:

```json
  "mediumSection": "Medium",
  "mediumApiToken": "APIトークン",
  "mediumTestConnection": "接続テスト",
  "mediumTestTesting": "テスト中...",
  "mediumConnectionSuccess": "認証済み: @{{username}}",
  "mediumConnectionFailed": "接続に失敗しました"
```

Note: i18next interpolation uses `{{username}}` (double curly braces).

- [ ] **Step 2: Add Medium keys to en/settings.json**

Add before the closing `}`:

```json
  "mediumSection": "Medium",
  "mediumApiToken": "API Token",
  "mediumTestConnection": "Test Connection",
  "mediumTestTesting": "Testing...",
  "mediumConnectionSuccess": "Authenticated: @{{username}}",
  "mediumConnectionFailed": "Connection failed"
```

- [ ] **Step 3: Add Medium publish dialog keys to ja/editor.json**

Add before the closing `}`:

```json
  "publishToMedium": "Mediumに投稿",
  "mediumPublishTitle": "Mediumに投稿",
  "mediumTitle": "タイトル",
  "mediumTags": "タグ（最大5つ）",
  "mediumTagsPlaceholder": "タグを入力してEnter",
  "mediumCanonicalUrl": "Canonical URL",
  "mediumPublish": "投稿",
  "mediumCancel": "キャンセル",
  "mediumPublishing": "投稿中...",
  "mediumUploadingImages": "画像をアップロード中... ({{current}}/{{total}})",
  "mediumPublishSuccess": "ドラフトを作成しました",
  "mediumPublishFailed": "投稿に失敗しました",
  "mediumTokenNotSet": "Medium APIトークンが設定されていません",
  "mediumImageUploadFailed": "画像のアップロードに失敗しました: {{name}}"
```

- [ ] **Step 4: Add Medium publish dialog keys to en/editor.json**

Add before the closing `}`:

```json
  "publishToMedium": "Publish to Medium",
  "mediumPublishTitle": "Publish to Medium",
  "mediumTitle": "Title",
  "mediumTags": "Tags (max 5)",
  "mediumTagsPlaceholder": "Type a tag and press Enter",
  "mediumCanonicalUrl": "Canonical URL",
  "mediumPublish": "Publish",
  "mediumCancel": "Cancel",
  "mediumPublishing": "Publishing...",
  "mediumUploadingImages": "Uploading images... ({{current}}/{{total}})",
  "mediumPublishSuccess": "Draft created",
  "mediumPublishFailed": "Publish failed",
  "mediumTokenNotSet": "Medium API token not set",
  "mediumImageUploadFailed": "Image upload failed: {{name}}"
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/i18n/locales/ja/settings.json src/shared/i18n/locales/en/settings.json src/shared/i18n/locales/ja/editor.json src/shared/i18n/locales/en/editor.json
git commit -m "feat(medium): add i18n keys for Medium publish feature"
```

---

### Task 2: Add MediumSettings type and settings store

**Files:**
- Modify: `src/shared/types/index.ts`
- Modify: `src/stores/settings-store.ts`

- [ ] **Step 1: Add MediumSettings type to shared types**

Add after the `RagSettings` interface (after line 97) in `src/shared/types/index.ts`:

```typescript
/** Medium publishing settings */
export interface MediumSettings {
  apiToken: string;
}
```

- [ ] **Step 2: Update settings store with mediumSettings**

In `src/stores/settings-store.ts`:

2a. Add `MediumSettings` to the import on line 8:

```typescript
import type { AiSettings, MediumSettings, RagSettings } from "@/shared/types";
```

2b. Add default after `DEFAULT_RAG_SETTINGS` (after line 27):

```typescript
const DEFAULT_MEDIUM_SETTINGS: MediumSettings = {
  apiToken: "",
};
```

2c. Add to `SettingsState` interface (after `speechModel` field, line 44):

```typescript
  mediumSettings: MediumSettings;
```

2d. Add setter to `SettingsState` interface (after `setSpeechModel` signature, line 59):

```typescript
  setMediumSettings: (settings: MediumSettings) => void;
```

2e. Add default value in the create store (after `speechModel: "Xenova/whisper-small" as SpeechModel,` line 78):

```typescript
      mediumSettings: DEFAULT_MEDIUM_SETTINGS,
```

2f. Add setter implementation (after `setSpeechModel` implementation, line 116):

```typescript
      setMediumSettings: (settings) => set({ mediumSettings: settings }),
```

2g. Add to `partialize` (after `speechModel: state.speechModel,` line 140):

```typescript
        mediumSettings: state.mediumSettings,
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/index.ts src/stores/settings-store.ts
git commit -m "feat(medium): add MediumSettings type and settings store"
```

---

### Task 3: Add Medium section to Settings "Other" tab

**Files:**
- Modify: `src/features/settings/components/SettingsDialog.tsx`

- [ ] **Step 1: Read SettingsDialog.tsx fully to understand local state pattern**

Read the full file to understand how `localAi` state pattern works (local copy of store value, saved on "Save" click).

- [ ] **Step 2: Add Medium local state and connection test logic**

In `SettingsDialog.tsx`, add state for Medium settings following the same pattern as AI settings:

Inside the component function, add after the existing local state declarations:

```typescript
  const [localMedium, setLocalMedium] = useState(
    useSettingsStore.getState().mediumSettings
  );
  const [mediumTestStatus, setMediumTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [mediumUsername, setMediumUsername] = useState("");

  const handleMediumTest = async () => {
    if (!localMedium.apiToken) return;
    setMediumTestStatus("testing");
    try {
      const result = await invoke<string>("medium_test_connection", {
        token: localMedium.apiToken,
      });
      const parsed = JSON.parse(result);
      setMediumUsername(parsed.username);
      setMediumTestStatus("success");
    } catch {
      setMediumTestStatus("error");
    }
  };
```

Ensure `localMedium` is saved in the existing `handleSave` function, adding:

```typescript
      useSettingsStore.getState().setMediumSettings(localMedium);
```

- [ ] **Step 3: Add Medium UI to the "other" tab**

In the `{activeTab === "other" && (...)}` block, add after the Zenn section (after the `</button>` for zennInit, before the closing `</>`):

```tsx
              <div className="settings-dialog__divider" />
              <div className="settings-dialog__section-title">
                {t("mediumSection")}
              </div>
              <div className="settings-dialog__field">
                <label className="settings-dialog__label">
                  {t("mediumApiToken")}
                </label>
                <input
                  type="password"
                  className="settings-dialog__input"
                  value={localMedium.apiToken}
                  onChange={(e) =>
                    setLocalMedium({ ...localMedium, apiToken: e.target.value })
                  }
                />
              </div>
              <div className="settings-dialog__field-row">
                <button
                  className="settings-dialog__test-btn"
                  onClick={handleMediumTest}
                  disabled={!localMedium.apiToken || mediumTestStatus === "testing"}
                >
                  {mediumTestStatus === "testing"
                    ? t("mediumTestTesting")
                    : t("mediumTestConnection")}
                </button>
                {mediumTestStatus === "success" && (
                  <span className="settings-dialog__test-ok">
                    {t("mediumConnectionSuccess", { username: mediumUsername })}
                  </span>
                )}
                {mediumTestStatus === "error" && (
                  <span className="settings-dialog__test-error">
                    {t("mediumConnectionFailed")}
                  </span>
                )}
              </div>
```

- [ ] **Step 4: Verify the settings dialog compiles**

Run: `npm run build 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/components/SettingsDialog.tsx
git commit -m "feat(medium): add Medium API token settings in Other tab"
```

---

### Task 4: Create Rust backend — medium.rs

**Files:**
- Create: `src-tauri/src/commands/medium.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add `multipart` feature to reqwest in Cargo.toml**

In `src-tauri/Cargo.toml`, change the reqwest line:

```toml
reqwest = { version = "0.12", features = ["stream", "json", "multipart"] }
```

- [ ] **Step 2: Create medium.rs with all three commands**

Create `src-tauri/src/commands/medium.rs`:

```rust
use serde::{Deserialize, Serialize};

const MEDIUM_API_BASE: &str = "https://api.medium.com/v1";

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediumUser {
    pub id: String,
    pub username: String,
    pub name: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediumPost {
    pub id: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediumImage {
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePostRequest {
    pub token: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub canonical_url: String,
}

/// Test connection by fetching the authenticated user info.
#[tauri::command]
pub async fn medium_test_connection(token: String) -> Result<String, String> {
    let client = build_client()?;
    let res = client
        .get(format!("{}/me", MEDIUM_API_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        return Err(format!("HTTP {}: {}", status, body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let data = &json["data"];
    let user = MediumUser {
        id: data["id"].as_str().unwrap_or("").to_string(),
        username: data["username"].as_str().unwrap_or("").to_string(),
        name: data["name"].as_str().unwrap_or("").to_string(),
        url: data["url"].as_str().unwrap_or("").to_string(),
    };

    serde_json::to_string(&user).map_err(|e| e.to_string())
}

/// Upload an image file to Medium and return the hosted URL.
#[tauri::command]
pub async fn medium_upload_image(token: String, file_path: String) -> Result<String, String> {
    let client = build_client()?;

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file {}: {}", file_path, e))?;

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();

    let mime = if file_name.ends_with(".png") {
        "image/png"
    } else if file_name.ends_with(".gif") {
        "image/gif"
    } else if file_name.ends_with(".webp") {
        "image/webp"
    } else if file_name.ends_with(".tiff") || file_name.ends_with(".tif") {
        "image/tiff"
    } else {
        "image/jpeg"
    };

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new().part("image", part);

    let res = client
        .post(format!("{}/images", MEDIUM_API_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        return Err(format!("HTTP {}: {}", status, body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let url = json["data"]["url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let img = MediumImage { url };
    serde_json::to_string(&img).map_err(|e| e.to_string())
}

/// Create a draft post on Medium.
#[tauri::command]
pub async fn medium_create_post(req: CreatePostRequest) -> Result<String, String> {
    let client = build_client()?;

    // First, get the user ID
    let me_res = client
        .get(format!("{}/me", MEDIUM_API_BASE))
        .header("Authorization", format!("Bearer {}", req.token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let me_status = me_res.status().as_u16();
    let me_body = me_res.text().await.unwrap_or_default();

    if me_status < 200 || me_status >= 300 {
        return Err(format!("Failed to get user: HTTP {}: {}", me_status, me_body));
    }

    let me_json: serde_json::Value =
        serde_json::from_str(&me_body).map_err(|e| format!("JSON parse error: {}", e))?;

    let user_id = me_json["data"]["id"]
        .as_str()
        .ok_or("Failed to get user ID")?;

    // Create the post
    let mut post_body = serde_json::json!({
        "title": req.title,
        "contentFormat": "html",
        "content": req.content,
        "publishStatus": "draft"
    });

    if !req.tags.is_empty() {
        post_body["tags"] = serde_json::json!(req.tags);
    }

    if !req.canonical_url.is_empty() {
        post_body["canonicalUrl"] = serde_json::json!(req.canonical_url);
    }

    let res = client
        .post(format!("{}/users/{}/posts", MEDIUM_API_BASE, user_id))
        .header("Authorization", format!("Bearer {}", req.token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&post_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        return Err(format!("HTTP {}: {}", status, body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let data = &json["data"];
    let post = MediumPost {
        id: data["id"].as_str().unwrap_or("").to_string(),
        url: data["url"].as_str().unwrap_or("").to_string(),
    };

    serde_json::to_string(&post).map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register the medium module in mod.rs**

In `src-tauri/src/commands/mod.rs`, add:

```rust
pub mod medium;
```

- [ ] **Step 4: Register commands in lib.rs**

In `src-tauri/src/lib.rs`, add after the VBA macro operations block (before `])`):

```rust
            // Medium operations
            commands::medium::medium_test_connection,
            commands::medium::medium_upload_image,
            commands::medium::medium_create_post,
```

- [ ] **Step 5: Verify Rust compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands/medium.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(medium): add Rust backend commands for Medium API"
```

---

### Task 5: Create MediumPublishDialog component

**Files:**
- Create: `src/features/medium/components/MediumPublishDialog.tsx`
- Create: `src/features/medium/components/MediumPublishDialog.css`

- [ ] **Step 1: Create MediumPublishDialog.css**

Create `src/features/medium/components/MediumPublishDialog.css`, following the VideoScenarioDialog pattern:

```css
.medium-publish-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.medium-publish-dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px 24px;
  min-width: 420px;
  max-width: 520px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.medium-publish-dialog__title {
  margin: 0 0 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.medium-publish-dialog__field {
  margin: 0 0 12px;
}

.medium-publish-dialog__field-label {
  display: block;
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  opacity: 0.7;
}

.medium-publish-dialog__input {
  width: 100%;
  padding: 6px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-base);
  color: var(--text);
  font-size: 12px;
  box-sizing: border-box;
}

.medium-publish-dialog__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}

.medium-publish-dialog__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--primary);
  color: #fff;
  font-size: 11px;
}

.medium-publish-dialog__tag-remove {
  cursor: pointer;
  opacity: 0.7;
  font-size: 14px;
  line-height: 1;
}

.medium-publish-dialog__tag-remove:hover {
  opacity: 1;
}

.medium-publish-dialog__status {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text);
  opacity: 0.7;
}

.medium-publish-dialog__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.medium-publish-dialog__btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-base);
  color: var(--text);
  transition: opacity 0.15s;
}

.medium-publish-dialog__btn:hover {
  opacity: 0.8;
}

.medium-publish-dialog__btn--primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.medium-publish-dialog__btn--primary:hover {
  opacity: 0.9;
}

.medium-publish-dialog__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 2: Create MediumPublishDialog.tsx**

Create `src/features/medium/components/MediumPublishDialog.tsx`:

```tsx
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./MediumPublishDialog.css";

export interface MediumPublishParams {
  title: string;
  tags: string[];
  canonicalUrl: string;
}

interface MediumPublishDialogProps {
  defaultTitle: string;
  defaultTags: string[];
  defaultCanonicalUrl: string;
  onSubmit: (params: MediumPublishParams) => void;
  onCancel: () => void;
}

export function MediumPublishDialog({
  defaultTitle,
  defaultTags,
  defaultCanonicalUrl,
  onSubmit,
  onCancel,
}: MediumPublishDialogProps) {
  const { t } = useTranslation("editor");

  const [title, setTitle] = useState(defaultTitle);
  const [tags, setTags] = useState<string[]>(defaultTags);
  const [tagInput, setTagInput] = useState("");
  const [canonicalUrl, setCanonicalUrl] = useState(defaultCanonicalUrl);

  const handleAddTag = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const tag = tagInput.trim();
      if (!tag || tags.length >= 5 || tags.includes(tag)) return;
      setTags([...tags, tag]);
      setTagInput("");
    },
    [tagInput, tags],
  );

  const handleRemoveTag = useCallback(
    (index: number) => {
      setTags(tags.filter((_, i) => i !== index));
    },
    [tags],
  );

  const handleSubmit = useCallback(() => {
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), tags, canonicalUrl: canonicalUrl.trim() });
  }, [title, tags, canonicalUrl, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    },
    [onCancel],
  );

  return (
    <div className="medium-publish-overlay" onClick={onCancel}>
      <div
        className="medium-publish-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="medium-publish-dialog__title">
          {t("mediumPublishTitle")}
        </h3>

        <div className="medium-publish-dialog__field">
          <span className="medium-publish-dialog__field-label">
            {t("mediumTitle")}
          </span>
          <input
            className="medium-publish-dialog__input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div className="medium-publish-dialog__field">
          <span className="medium-publish-dialog__field-label">
            {t("mediumTags")}
          </span>
          <div className="medium-publish-dialog__tags">
            {tags.map((tag, i) => (
              <span key={tag} className="medium-publish-dialog__tag">
                {tag}
                <span
                  className="medium-publish-dialog__tag-remove"
                  onClick={() => handleRemoveTag(i)}
                >
                  ×
                </span>
              </span>
            ))}
          </div>
          {tags.length < 5 && (
            <input
              className="medium-publish-dialog__input"
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              placeholder={t("mediumTagsPlaceholder")}
            />
          )}
        </div>

        <div className="medium-publish-dialog__field">
          <span className="medium-publish-dialog__field-label">
            {t("mediumCanonicalUrl")}
          </span>
          <input
            className="medium-publish-dialog__input"
            type="text"
            value={canonicalUrl}
            onChange={(e) => setCanonicalUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>

        <div className="medium-publish-dialog__actions">
          <button className="medium-publish-dialog__btn" onClick={onCancel}>
            {t("mediumCancel")}
          </button>
          <button
            className="medium-publish-dialog__btn medium-publish-dialog__btn--primary"
            onClick={handleSubmit}
            disabled={!title.trim()}
          >
            {t("mediumPublish")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build 2>&1 | head -30`

- [ ] **Step 4: Commit**

```bash
git add src/features/medium/components/MediumPublishDialog.tsx src/features/medium/components/MediumPublishDialog.css
git commit -m "feat(medium): add MediumPublishDialog component"
```

---

### Task 6: Add "publish-to-medium" to builtin commands

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-commands.ts`

- [ ] **Step 1: Add publish-to-medium entry**

In `src/features/opencode-config/lib/builtin-commands.ts`, add a new entry to `BUILTIN_COMMANDS` object (before the closing `};`). This is a placeholder entry so it appears in the command dropdown — the actual execution is handled as a special case in PreviewPanel:

```typescript
  "publish-to-medium": {
    name: "publish-to-medium",
    description: "Publish current Markdown article as a draft to Medium",
    template: "",
  },
```

- [ ] **Step 2: Commit**

```bash
git add src/features/opencode-config/lib/builtin-commands.ts
git commit -m "feat(medium): register publish-to-medium in builtin commands"
```

---

### Task 7: Integrate publish flow into PreviewPanel

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

This is the main integration task. PreviewPanel needs to:
1. Show a "publish-to-medium" special command in the dropdown
2. Open MediumPublishDialog on selection
3. Extract frontmatter for defaults
4. Convert Markdown → HTML, upload images, create post

- [ ] **Step 1: Add imports at top of PreviewPanel.tsx**

Add after the existing imports:

```typescript
import { MediumPublishDialog } from "@/features/medium/components/MediumPublishDialog";
import type { MediumPublishParams } from "@/features/medium/components/MediumPublishDialog";
```

- [ ] **Step 2: Add Medium dialog state**

Inside the `PreviewPanel` component, add after `scenarioDialog` state declaration (around line 355):

```typescript
  const [mediumDialog, setMediumDialog] = useState<{
    title: string;
    tags: string[];
    canonicalUrl: string;
    body: string;
    filePath: string;
  } | null>(null);
```

- [ ] **Step 3: Add handlePublishToMedium function**

Add after `handleEnterVideoMode` callback (around line 380), before `handleCommandSelect`:

```typescript
  const handlePublishToMedium = useCallback(() => {
    if (!filePath) return;

    const token = useSettingsStore.getState().mediumSettings.apiToken;
    if (!token) {
      alert(t("mediumTokenNotSet"));
      return;
    }

    const raw = activeTab?.content ?? "";
    const { meta, body } = extractFrontMatter(raw);

    // Parse title: frontmatter > first h1 > filename
    let title = meta?.["medium_title"] ?? "";
    if (!title) {
      const h1Match = body.match(/^#\s+(.+)$/m);
      title = h1Match ? h1Match[1] : filePath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? "";
    }

    // Parse tags (frontmatter value is a string like "[\"tag1\", \"tag2\"]")
    let tags: string[] = [];
    const tagsRaw = meta?.["medium_tags"] ?? "";
    if (tagsRaw) {
      try {
        const parsed = JSON.parse(tagsRaw);
        if (Array.isArray(parsed)) tags = parsed.slice(0, 5);
      } catch {
        // Try comma-separated fallback
        tags = tagsRaw
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
          .slice(0, 5);
      }
    }

    const canonicalUrl = meta?.["medium_canonical_url"] ?? "";

    setMediumDialog({ title, tags, canonicalUrl, body, filePath });
  }, [filePath, activeTab?.content, t]);
```

- [ ] **Step 4: Add handleMediumSubmit function**

Add after `handlePublishToMedium`:

```typescript
  const handleMediumSubmit = useCallback(
    async (params: MediumPublishParams) => {
      if (!mediumDialog) return;
      const { body, filePath: mdFilePath } = mediumDialog;
      setMediumDialog(null);

      const token = useSettingsStore.getState().mediumSettings.apiToken;

      try {
        // Convert Markdown to HTML
        let html = marked(body) as string;

        // Extract local image paths and upload them
        const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
        const localImages: { original: string; absPath: string }[] = [];
        let match: RegExpExecArray | null;

        while ((match = imgRegex.exec(html)) !== null) {
          const src = match[1];
          // Skip already-hosted URLs
          if (/^https?:\/\//i.test(src)) continue;

          // Resolve relative path against the file's directory
          const fileDir = mdFilePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
          const absPath = src.startsWith("/") || /^[a-zA-Z]:/.test(src)
            ? src
            : `${fileDir}/${src}`;
          localImages.push({ original: src, absPath });
        }

        // Upload images sequentially
        for (let i = 0; i < localImages.length; i++) {
          const img = localImages[i];
          const result = await invoke<string>("medium_upload_image", {
            token,
            filePath: img.absPath,
          });
          const parsed = JSON.parse(result);
          if (parsed.url) {
            html = html.split(img.original).join(parsed.url);
          }
        }

        // Create the post
        const result = await invoke<string>("medium_create_post", {
          req: {
            token,
            title: params.title,
            content: html,
            tags: params.tags,
            canonicalUrl: params.canonicalUrl,
          },
        });

        const post = JSON.parse(result);
        alert(`${t("mediumPublishSuccess")}\n${post.url}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`${t("mediumPublishFailed")}: ${msg}`);
      }
    },
    [mediumDialog, t],
  );
```

- [ ] **Step 5: Add special-case handling in handleCommandSelect**

In the existing `handleCommandSelect` function, add after the `generate-video-scenario` check:

```typescript
    if (commandName === "publish-to-medium") {
      handlePublishToMedium();
      return;
    }
```

Update the `handleCommandSelect` dependency array to include `handlePublishToMedium`.

- [ ] **Step 6: Render MediumPublishDialog**

In the JSX, add just before the `VideoScenarioDialog` render (search for `{scenarioDialog &&`). Add before it:

```tsx
      {mediumDialog && (
        <MediumPublishDialog
          defaultTitle={mediumDialog.title}
          defaultTags={mediumDialog.tags}
          defaultCanonicalUrl={mediumDialog.canonicalUrl}
          onSubmit={handleMediumSubmit}
          onCancel={() => setMediumDialog(null)}
        />
      )}
```

- [ ] **Step 7: Verify build**

Run: `npm run build 2>&1 | head -30`
Expected: Build succeeds without errors.

- [ ] **Step 8: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(medium): integrate publish-to-medium flow in PreviewPanel"
```

---

### Task 8: Manual testing checklist

This is not code — it's a testing checklist to verify the feature end-to-end.

- [ ] **Step 1: Verify settings UI**

1. Open Settings → Other tab
2. Verify "Medium" section appears below Zenn
3. Enter a Medium API token (get from https://medium.com/me/settings/security)
4. Click "Test Connection" → verify username appears
5. Click "Save" → reopen settings → verify token persisted

- [ ] **Step 2: Verify command dropdown**

1. Open a `.md` file in the editor
2. Verify "publish-to-medium" appears in the command dropdown
3. Without token: select it → verify warning alert appears
4. With token: select it → verify dialog opens

- [ ] **Step 3: Verify publish dialog**

1. Create a test `.md` file with frontmatter:
   ```yaml
   ---
   medium_title: "Test Article"
   medium_tags: ["test", "markdown"]
   medium_canonical_url: ""
   ---
   # Hello World
   This is a test.
   ```
2. Select "publish-to-medium" → verify title and tags are pre-filled
3. Edit tags (add/remove) → verify max 5 limit works
4. Click "Publish" → verify draft is created on Medium
5. Verify the returned URL opens the draft on Medium

- [ ] **Step 4: Verify image upload (optional, if test article has images)**

1. Add a local image to the test article: `![photo](./test.png)`
2. Publish → verify the image is uploaded and displayed in the Medium draft
