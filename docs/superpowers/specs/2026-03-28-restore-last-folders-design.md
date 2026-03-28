# Restore Last Folders on Startup

## Overview

Add a setting to restore previously opened folders when the app launches. When enabled (default: ON), the app will reopen all folders that were open in the previous session, including the active folder selection.

## Requirements

- Settings toggle in the General tab: "Restore last folders on startup" (default: ON)
- Persist `openFolderPaths` and `activeFolderPath` from `tab-store` across sessions
- On startup, restore all previously open folders if the setting is enabled
- Skip folders that no longer exist on disk
- Restore the active folder selection

## Design

### 1. Settings Store (`settings-store.ts`)

Add `restoreLastFolders: boolean` (default: `true`) to `SettingsState`.

- Add `setRestoreLastFolders` action
- Include in `partialize` for persistence

### 2. Tab Store (`tab-store.ts`)

Add Zustand `persist` middleware to `tab-store` with selective persistence.

- localStorage key: `"mdium-tab-folders"`
- `partialize` only persists: `openFolderPaths`, `activeFolderPath`
- All other state (tabs, activeTabId, folderLastActiveTab, etc.) remains ephemeral

### 3. App Startup Logic (`App.tsx`)

Add a `useEffect` that runs once on mount:

1. Read `restoreLastFolders` from settings store
2. If disabled, clear persisted folder data and return
3. Read persisted `openFolderPaths` and `activeFolderPath`
4. For each folder path, check existence via Tauri `invoke("path_exists", { path })`
5. Call `openFolder()` for each valid path
6. Call `switchFolder()` to restore the active folder

Use an existing Tauri command or `fs` plugin to check folder existence. The `get_file_tree` command already handles non-existent paths gracefully, but an explicit existence check is cleaner.

### 4. Settings Dialog (`SettingsDialog.tsx`)

Add a toggle in the General tab, after the autoSave toggle:

```
[x] Restore last folders on startup
    Reopen folders from previous session when the app starts
```

Uses local state pattern consistent with existing toggles (localAutoSave, etc.).

### 5. i18n

Add to both `ja/settings.json` and `en/settings.json`:

- `restoreLastFolders`: "前回のフォルダを復元" / "Restore Last Folders"
- `restoreLastFoldersDescription`: "起動時に前回開いていたフォルダを自動的に開きます" / "Automatically reopen folders from previous session on startup"

### 6. Folder Existence Check

Use `invoke("path_exists")` or Tauri's `fs` plugin `exists()` function to verify each persisted folder path still exists before attempting to open it. Skip any that don't exist.

## Files to Modify

1. `src/stores/settings-store.ts` - Add `restoreLastFolders` setting
2. `src/stores/tab-store.ts` - Add persist middleware with selective partialize
3. `src/app/App.tsx` - Add startup restoration logic
4. `src/features/settings/components/SettingsDialog.tsx` - Add toggle UI
5. `src/shared/i18n/locales/ja/settings.json` - Add Japanese strings
6. `src/shared/i18n/locales/en/settings.json` - Add English strings
