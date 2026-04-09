# Medium Publish Feature

MDium from the command dropdown, you can publish Markdown articles as drafts to Medium.com.

## Setup

1. Get a Medium Integration Token from [Medium Settings](https://medium.com/me/settings/security)
2. Open MDium Settings (gear icon) -> "Other" tab
3. Paste the token in the "Medium" section's API Token field
4. Click "Test Connection" to verify — your username will be displayed on success
5. Click "Save"

## Usage

### 1. Write your article

Write a Markdown article as usual. Optionally add Medium-specific frontmatter at the top of the file:

```yaml
---
medium_title: "Your Article Title"
medium_tags: ["javascript", "react", "tutorial"]
medium_canonical_url: "https://yourblog.com/original-post"
---
```

| Field | Description | Required |
|-------|-------------|----------|
| `medium_title` | Article title on Medium. Falls back to the first `# h1` heading, then the filename. | No |
| `medium_tags` | Up to 5 tags (JSON array format). | No |
| `medium_canonical_url` | Original URL if cross-posting from another site. | No |

The `medium_` prefix avoids conflicts with Zenn frontmatter (`title`, `topics`, etc.), so both can coexist in the same file.

### 2. Publish

1. Open the `.md` file in the editor
2. Select **publish-to-medium** from the command dropdown in the preview toolbar
3. A confirmation dialog appears with the parsed metadata — edit if needed
4. Click "Publish"

The article is created as a **draft** on Medium. A URL to the draft is shown on success. Open it in your browser to review and publish from Medium's editor.

### 3. Images

Local images referenced in the Markdown are automatically uploaded to Medium before posting:

- `![photo](./images/photo.png)` — relative paths are resolved against the file's directory
- `![logo](C:\Users\me\pics\logo.jpg)` — absolute paths are used directly
- `![badge](https://img.shields.io/badge/test-pass-green)` — URLs are left as-is

Supported formats: PNG, JPEG, GIF, WebP, TIFF.

## Notes

- Articles are always created as **drafts**. Publishing is done from Medium's web UI.
- Medium limits tags to 5 per article. Extra tags are silently trimmed.
- The token is stored locally in the app's settings (localStorage). It is never sent to any server other than `api.medium.com`.
