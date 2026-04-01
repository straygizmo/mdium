# Medium Direct Publish Feature - Design Spec

## Overview

From the toolbar command dropdown, users can publish Markdown articles as drafts to Medium.com via the Medium API. Authentication uses a self-issued access token. Local images are automatically uploaded to Medium before posting.

## Architecture

```
Command Dropdown ("Mediumに投稿")
  → MediumPublishDialog (frontmatter metadata confirmation)
  → Frontend: Markdown → HTML conversion (marked)
  → Frontend: Extract local image paths from HTML
  → Tauri Command: medium_upload_image (per image)
  → Frontend: Replace image src with Medium URLs
  → Tauri Command: medium_create_post (HTML + metadata)
  → Toast notification (success with draft URL / failure with error)
```

**Approach: Rust backend via Tauri commands** — All HTTP calls to Medium API go through the Rust backend using `reqwest`. This avoids CORS issues, keeps the API token out of the frontend JS context, and follows the existing pattern from `ai.rs`.

## 1. Medium Frontmatter Format

```yaml
---
medium_title: "Article Title"
medium_tags: ["rust", "tauri", "markdown"]
medium_canonical_url: "https://example.com/original-post"
---
```

- Prefix `medium_` avoids collision with Zenn frontmatter keys (`title`, `topics`, etc.)
- `medium_title`: If absent, falls back to the first `# h1` in the body
- `medium_tags`: Max 5 (Medium API limit)
- `medium_canonical_url`: Optional, for cross-posting
- Parsed by existing `extractFrontMatter()` in PreviewPanel.tsx (line 236-262)

## 2. Settings (Token Management)

**Location**: "Other" tab in SettingsDialog.tsx

**UI**:
- Section title: "Medium"
- API Token input (`type="password"`)
- "Test Connection" button

**Store** (`settings-store.ts`):
```typescript
interface MediumSettings {
  apiToken: string;
}
```
- Added to the store's state interface
- Included in `partialize` for localStorage persistence

**Connection Test**:
- Calls `medium_test_connection` Tauri command
- Hits `GET https://api.medium.com/v1/me`
- Success: displays "Authenticated: @{username}"
- Failure: displays error message

## 3. Rust Backend (`src-tauri/src/commands/medium.rs`)

Three Tauri commands, following the `ai.rs` pattern with `reqwest::Client`:

### 3.1 `medium_test_connection`
- `GET https://api.medium.com/v1/me`
- Header: `Authorization: Bearer {token}`
- Returns: `{ id, username, name, url }`

### 3.2 `medium_upload_image`
- `POST https://api.medium.com/v1/images`
- Multipart/form-data with binary image data
- Header: `Authorization: Bearer {token}`
- Input: image file path (read from disk in Rust)
- Returns: `{ url }` (Medium-hosted URL)

### 3.3 `medium_create_post`
- First calls `/v1/me` to get userId
- `POST https://api.medium.com/v1/users/{userId}/posts`
- Request body:
  ```json
  {
    "title": "Article Title",
    "contentFormat": "html",
    "content": "<h1>...</h1><p>...</p>",
    "tags": ["tag1", "tag2"],
    "canonicalUrl": "https://...",
    "publishStatus": "draft"
  }
  ```
- Returns: `{ id, url }` (draft URL on Medium)

**Registration**: Add all three commands to `invoke_handler` in `lib.rs`.

## 4. Frontend Publish Flow

### 4.1 Command Registration

In `handleCommandSelect` (PreviewPanel.tsx), add special-case handling (same as `generate-video-scenario`):

```typescript
if (commandName === "publish-to-medium") {
  handlePublishToMedium();
  return;
}
```

The command appears in the dropdown alongside other global commands.

### 4.2 Feature Module (`src/features/medium/`)

New feature module containing:

- `MediumPublishDialog.tsx` — Confirmation/edit dialog for metadata before posting

### 4.3 Publish Flow

```
1. User selects "Mediumに投稿" from command dropdown
2. Check: Is mediumSettings.apiToken set?
   - No → Show warning toast, abort
   - Yes → Continue
3. Extract frontmatter from current file using extractFrontMatter()
4. Open MediumPublishDialog with pre-filled values:
   - Title: medium_title || first h1 || filename
   - Tags: medium_tags || []
   - Canonical URL: medium_canonical_url || ""
5. User confirms or edits metadata, clicks "Publish"
6. Convert Markdown body to HTML using existing marked configuration
7. Extract <img src="..."> from HTML, filter for local paths
8. For each local image:
   - Call medium_upload_image with file path
   - Replace src in HTML with returned Medium URL
9. Call medium_create_post with HTML + metadata
10. Success → Toast with draft URL
    Failure → Toast with error message
```

### 4.4 MediumPublishDialog

- Modal dialog (consistent with existing dialogs like ZennNewArticleDialog)
- Fields: Title (text input), Tags (tag input, max 5), Canonical URL (text input)
- Buttons: Publish, Cancel
- Loading state during upload/post

## 5. Image Handling

1. After Markdown → HTML conversion, parse HTML to find all `<img>` tags
2. Classify each `src`:
   - Absolute URL (`https://...`) → skip (already hosted)
   - Relative path (`./images/photo.png`) → resolve against file's directory
   - Absolute local path (`C:\...` or `/...`) → use directly
3. Upload each local image via `medium_upload_image`
4. Replace `src` attribute with returned Medium URL
5. Images are uploaded sequentially to avoid rate limiting

## 6. i18n Keys

### settings.json
| Key | ja | en |
|-----|----|----|
| `mediumSection` | Medium | Medium |
| `mediumApiToken` | APIトークン | API Token |
| `mediumTestConnection` | 接続テスト | Test Connection |
| `mediumConnectionSuccess` | 認証済み: @{username} | Authenticated: @{username} |
| `mediumConnectionFailed` | 接続に失敗しました | Connection failed |

### toolbar.json
| Key | ja | en |
|-----|----|----|
| `publishToMedium` | Mediumに投稿 | Publish to Medium |
| `mediumPublishTitle` | Mediumに投稿 | Publish to Medium |
| `mediumTitle` | タイトル | Title |
| `mediumTags` | タグ（最大5つ） | Tags (max 5) |
| `mediumCanonicalUrl` | Canonical URL | Canonical URL |
| `mediumPublish` | 投稿 | Publish |
| `mediumCancel` | キャンセル | Cancel |
| `mediumPublishing` | 投稿中... | Publishing... |
| `mediumPublishSuccess` | ドラフトを作成しました | Draft created |
| `mediumPublishFailed` | 投稿に失敗しました | Publish failed |
| `mediumTokenNotSet` | Medium APIトークンが設定されていません | Medium API token not set |

## 7. Error Handling

- **Token not set**: Toast warning, no API call
- **Connection test failure**: Display error in settings UI
- **Image upload failure**: Abort publish, show error toast with failed image name
- **Post creation failure**: Show error toast with Medium API error message
- **Network errors**: Caught by reqwest, surfaced as error strings

## 8. Files to Create/Modify

### New Files
- `src-tauri/src/commands/medium.rs` — Tauri backend commands
- `src/features/medium/components/MediumPublishDialog.tsx` — Publish dialog component
- `src/features/medium/index.ts` — Feature module export

### Modified Files
- `src-tauri/src/lib.rs` — Register medium commands
- `src-tauri/src/commands/mod.rs` — Add medium module
- `src/stores/settings-store.ts` — Add mediumSettings
- `src/shared/types/index.ts` — Add MediumSettings type
- `src/features/settings/components/SettingsDialog.tsx` — Add Medium section to Other tab
- `src/features/preview/components/PreviewPanel.tsx` — Add publish-to-medium command handling
- `src/features/opencode-config/lib/builtin-commands.ts` — Add publish-to-medium entry
- `src/shared/i18n/locales/ja/settings.json` — Add Medium i18n keys
- `src/shared/i18n/locales/en/settings.json` — Add Medium i18n keys
- `src/shared/i18n/locales/ja/toolbar.json` — Add Medium i18n keys
- `src/shared/i18n/locales/en/toolbar.json` — Add Medium i18n keys
