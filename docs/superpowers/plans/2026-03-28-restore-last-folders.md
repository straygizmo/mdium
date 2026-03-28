# Restore Last Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically restore previously opened folders when the app launches, controlled by a user-facing toggle in settings.

**Architecture:** Add `restoreLastFolders` boolean to the persisted settings store. Add Zustand `persist` middleware to the tab store with selective `partialize` (only folder paths). On startup, read persisted folder paths and restore them via existing `openFolder()`/`switchFolder()` actions.

**Tech Stack:** React, Zustand (persist middleware), Tauri (invoke `folder_exists`), i18next

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/stores/settings-store.ts` | Modify | Add `restoreLastFolders` boolean + setter |
| `src/stores/tab-store.ts` | Modify | Add `persist` middleware with selective partialize |
| `src/shared/i18n/locales/ja/settings.json` | Modify | Add Japanese translation strings |
| `src/shared/i18n/locales/en/settings.json` | Modify | Add English translation strings |
| `src/features/settings/components/SettingsDialog.tsx` | Modify | Add toggle in General tab |
| `src/app/App.tsx` | Modify | Add startup restoration logic |

---

### Task 1: Add `restoreLastFolders` to settings store

**Files:**
- Modify: `src/stores/settings-store.ts`

- [ ] **Step 1: Add the setting property and setter to the interface**

In `SettingsState` interface (after `autoSave: boolean;` line 34), add:

```typescript
restoreLastFolders: boolean;
```

In the actions section (after `setAutoSave: (enabled: boolean) => void;` line 47), add:

```typescript
setRestoreLastFolders: (enabled: boolean) => void;
```

- [ ] **Step 2: Add the default value and setter implementation**

In the store creation (after `autoSave: false,` line 66), add:

```typescript
restoreLastFolders: true,
```

After the `setAutoSave` action (line 90), add:

```typescript
setRestoreLastFolders: (enabled) => set({ restoreLastFolders: enabled }),
```

- [ ] **Step 3: Add to partialize for persistence**

In the `partialize` function (after `autoSave: state.autoSave,` line 127), add:

```typescript
restoreLastFolders: state.restoreLastFolders,
```

- [ ] **Step 4: Commit**

```bash
git add src/stores/settings-store.ts
git commit -m "feat: add restoreLastFolders setting to settings store"
```

---

### Task 2: Add persist middleware to tab store

**Files:**
- Modify: `src/stores/tab-store.ts`

- [ ] **Step 1: Import persist middleware**

Add `persist` to the zustand import:

```typescript
import { create } from "zustand";
import { persist } from "zustand/middleware";
```

- [ ] **Step 2: Wrap the store with persist middleware**

Change the store creation from:

```typescript
export const useTabStore = create<TabState>()((set, get) => ({
```

to:

```typescript
export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
```

- [ ] **Step 3: Add the persist configuration after the closing `})` of the store object**

After the final `}))` that closes the store actions, add the persist config so the full closing looks like:

```typescript
    }),
    {
      name: "mdium-tab-folders",
      partialize: (state) => ({
        openFolderPaths: state.openFolderPaths,
        activeFolderPath: state.activeFolderPath,
      }),
    }
  )
);
```

The old closing `}));` becomes the above structure. Make sure the store ends with `));` (one for `persist()`, one for `create()`).

- [ ] **Step 4: Commit**

```bash
git add src/stores/tab-store.ts
git commit -m "feat: add persist middleware to tab store for folder paths"
```

---

### Task 3: Add i18n translation strings

**Files:**
- Modify: `src/shared/i18n/locales/ja/settings.json`
- Modify: `src/shared/i18n/locales/en/settings.json`

- [ ] **Step 1: Add Japanese strings**

In `src/shared/i18n/locales/ja/settings.json`, after the `"autoSaveDescription"` entry (line 12), add:

```json
"restoreLastFolders": "前回のフォルダを復元",
"restoreLastFoldersDescription": "起動時に前回開いていたフォルダを自動的に開きます",
```

- [ ] **Step 2: Add English strings**

In `src/shared/i18n/locales/en/settings.json`, after the `"autoSaveDescription"` entry (line 12), add:

```json
"restoreLastFolders": "Restore Last Folders",
"restoreLastFoldersDescription": "Automatically reopen folders from previous session on startup",
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/ja/settings.json src/shared/i18n/locales/en/settings.json
git commit -m "feat: add i18n strings for restore last folders setting"
```

---

### Task 4: Add toggle to Settings Dialog

**Files:**
- Modify: `src/features/settings/components/SettingsDialog.tsx`

- [ ] **Step 1: Add restoreLastFolders to the destructured settings**

In the `useSettingsStore()` destructure (around line 53-61), add `restoreLastFolders` and `setRestoreLastFolders`:

```typescript
const {
  showSettings, setShowSettings,
  autoSave, setAutoSave,
  restoreLastFolders, setRestoreLastFolders,
  aiSettings, setAiSettings,
  addVerifiedModel,
  speechEnabled, setSpeechEnabled,
  speechModel, setSpeechModel,
  language,
} = useSettingsStore();
```

- [ ] **Step 2: Add local state for the toggle**

After the `localAutoSave` state declaration (line 66), add:

```typescript
const [localRestoreLastFolders, setLocalRestoreLastFolders] = useState(restoreLastFolders);
```

- [ ] **Step 3: Reset local state when dialog opens**

In the `useEffect` that resets local state when `showSettings` changes (around line 77-87), add after `setLocalAutoSave(autoSave);`:

```typescript
setLocalRestoreLastFolders(restoreLastFolders);
```

- [ ] **Step 4: Save the setting in handleSave**

In `handleSave` (around line 152-158), add after `setAutoSave(localAutoSave);`:

```typescript
setRestoreLastFolders(localRestoreLastFolders);
```

- [ ] **Step 5: Add the toggle UI in the General tab**

In the General tab JSX, after the autoSave toggle group's closing `</div>` and its `<div className="settings-dialog__divider" />` (around line 299-300), add:

```tsx
<div className="settings-dialog__toggle-group">
  <label className="settings-dialog__toggle">
    <span>{t("restoreLastFolders")}</span>
    <input
      type="checkbox"
      checked={localRestoreLastFolders}
      onChange={(e) => setLocalRestoreLastFolders(e.target.checked)}
    />
  </label>
  <span className="settings-dialog__description">
    {t("restoreLastFoldersDescription")}
  </span>
</div>
<div className="settings-dialog__divider" />
```

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/components/SettingsDialog.tsx
git commit -m "feat: add restore last folders toggle to settings dialog"
```

---

### Task 5: Add startup restoration logic

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Add the restore effect**

In `App.tsx`, after the `useEffect` that calls `initializeTheme()` (around line 165-167), add a new effect:

```typescript
// Restore last folders on startup
useEffect(() => {
  const restoreLastFolders = useSettingsStore.getState().restoreLastFolders;
  if (!restoreLastFolders) return;

  const persisted = JSON.parse(
    localStorage.getItem("mdium-tab-folders") ?? "null"
  );
  const folderPaths: string[] = persisted?.state?.openFolderPaths ?? [];
  const lastActiveFolderPath: string | null = persisted?.state?.activeFolderPath ?? null;

  if (folderPaths.length === 0) return;

  (async () => {
    for (const path of folderPaths) {
      const exists = await invoke<boolean>("folder_exists", { path });
      if (exists) {
        openFolder(path);
      }
    }
    // Restore active folder
    if (lastActiveFolderPath) {
      const currentFolders = useTabStore.getState().openFolderPaths;
      if (currentFolders.includes(lastActiveFolderPath)) {
        useTabStore.getState().switchFolder(lastActiveFolderPath);
      }
    }
  })();
}, []);
```

This reads persisted folder data directly from localStorage (the same key Zustand persist uses), checks each folder's existence via the existing `folder_exists` Tauri command, and restores them using the existing `openFolder()` and `switchFolder()` actions.

Note: We read localStorage directly instead of the Zustand store because on initial render the hydration from persist may race with this effect. Reading localStorage is synchronous and reliable.

- [ ] **Step 2: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat: restore last folders on app startup"
```

---

### Task 6: Manual verification

- [ ] **Step 1: Build and run the app**

```bash
npm run dev
```

- [ ] **Step 2: Verify the setting toggle**

1. Open Settings > General tab
2. Confirm "Restore Last Folders" toggle appears after auto-save, default ON
3. Toggle OFF, save, reopen settings — confirm it stays OFF
4. Toggle ON, save

- [ ] **Step 3: Verify folder restoration**

1. Open 2-3 folders in the app
2. Close and reopen the app
3. Confirm all folders are restored and the active folder is correct

- [ ] **Step 4: Verify disabled behavior**

1. Turn off the setting
2. Close and reopen the app
3. Confirm app starts with no folders open

- [ ] **Step 5: Verify deleted folder handling**

1. Open a folder, close the app
2. Delete or rename that folder on disk
3. Reopen the app — confirm it skips the missing folder without errors

- [ ] **Step 6: Verify language switching**

1. Switch to English, confirm toggle label reads "Restore Last Folders"
2. Switch to Japanese, confirm toggle label reads "前回のフォルダを復元"
