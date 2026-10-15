import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { OpencodeChat } from "@/features/opencode-config/components/OpencodeChat";
import {
  doConnect,
  doCreateNewSession,
  doLoadSession,
  useChatUIStore,
} from "@/features/opencode-config/hooks/useOpencodeChat";
import { useMacroChatStore, workbookKey } from "@/stores/macro-chat-store";
import "./MacroChatPane.css";

const LOCK_RECHECK_MS = 5000;

interface VbaModule {
  name: string;
  moduleType: string;
  path: string | null;
}

interface ListResult {
  extracted: boolean;
  locked: boolean;
  modules: VbaModule[];
}

interface WorkbookLock {
  locked: boolean;
  reason: string | null;
}

export interface MacroChatPaneProps {
  filePath: string;
  fileName: string;
  folderPath: string | null;
}

/** Message of a `{"error","message"}` command failure, or the raw text. */
function errorInfo(e: unknown): { code: string | null; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.message === "string") return { code: parsed.error ?? null, message: parsed.message };
  } catch {
    // not JSON
  }
  return { code: null, message: raw };
}

export function MacroChatPane({ filePath, fileName, folderPath }: MacroChatPaneProps) {
  const { t } = useTranslation("editor");
  const [list, setList] = useState<ListResult | null>(null);
  const [noMacros, setNoMacros] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [lock, setLock] = useState<WorkbookLock>({ locked: false, reason: null });
  const setLocked = useMacroChatStore((s) => s.setLocked);
  const currentSessionId = useChatUIStore((s) => s.currentSessionId);
  // True while this pane owns the shared chat session (between bind and unmount).
  const boundRef = useRef(false);
  // Session id the current bind loaded, or null when a fresh session awaits its first message.
  const expectedSessionRef = useRef<string | null>(null);
  // currentSessionId observed when the bind settled; a fresh session must differ from it.
  const previousSessionRef = useRef<string | null>(null);

  const refreshModules = useCallback(async () => {
    try {
      const res = await invoke<ListResult>("list_vba_modules", { xlsmPath: filePath });
      setList(res);
      setNoMacros(false);
      setListError(null);
    } catch (e) {
      const info = errorInfo(e);
      setList(null);
      setNoMacros(info.code === "no_vba_project");
      setListError(info.code === "no_vba_project" ? null : info.message);
    }
  }, [filePath]);

  const checkLock = useCallback(async () => {
    try {
      const res = await invoke<WorkbookLock>("check_workbook_lock", { xlsmPath: filePath });
      setLock(res);
      setLocked(filePath, res.locked);
    } catch {
      // Leave the push-side check to decide; no banner on probe failure.
    }
  }, [filePath, setLocked]);

  // Bind the shared chat to this workbook's session.
  useEffect(() => {
    if (!folderPath) return;
    let cancelled = false;
    boundRef.current = false;
    expectedSessionRef.current = null;
    previousSessionRef.current = useChatUIStore.getState().currentSessionId;
    (async () => {
      await doConnect(folderPath);
      if (cancelled) return;
      const store = useMacroChatStore.getState();
      const bound = store.getSession(filePath);
      let expected: string | null = null;
      if (bound) {
        // doLoadSession swallows its errors, so success is judged by the resulting id.
        try {
          await doLoadSession(bound);
        } catch {
          // handled by the id check below
        }
        if (cancelled) return;
        if (useChatUIStore.getState().currentSessionId === bound) {
          expected = bound;
        } else {
          store.setSession(filePath, null);
          await doCreateNewSession();
        }
      } else {
        await doCreateNewSession();
      }
      if (cancelled) return;
      expectedSessionRef.current = expected;
      previousSessionRef.current = useChatUIStore.getState().currentSessionId;
      boundRef.current = true;
    })();
    return () => {
      cancelled = true;
      boundRef.current = false;
    };
  }, [filePath, folderPath]);

  // Remember the session opencode creates on the first message.
  useEffect(() => {
    if (!boundRef.current || !currentSessionId) return;
    const expected = expectedSessionRef.current;
    if (expected === null ? currentSessionId === previousSessionRef.current : currentSessionId !== expected) return;
    const store = useMacroChatStore.getState();
    // Never steal a session that another workbook already owns (late loads of a previous bind).
    const ownedElsewhere = Object.entries(store.sessionByWorkbook).some(
      ([key, id]) => key !== workbookKey(filePath) && id === currentSessionId,
    );
    if (ownedElsewhere) return;
    if (store.getSession(filePath) !== currentSessionId) store.setSession(filePath, currentSessionId);
  }, [currentSessionId, filePath]);

  useEffect(() => {
    refreshModules();
    checkLock();
  }, [refreshModules, checkLock]);

  // While locked, poll so the banner clears itself once Excel closes the file.
  useEffect(() => {
    if (!lock.locked) return;
    const timer = setInterval(checkLock, LOCK_RECHECK_MS);
    return () => clearInterval(timer);
  }, [lock.locked, checkLock]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen<{ path: string }>("vba-pushed", (ev) => {
      if (ev.payload.path === filePath) {
        refreshModules();
        checkLock();
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [filePath, refreshModules, checkLock]);

  const handleNewChat = useCallback(async () => {
    useMacroChatStore.getState().setSession(filePath, null);
    await doCreateNewSession();
  }, [filePath]);

  if (!folderPath) {
    return (
      <div className="macro-chat">
        <div className="macro-chat__needs-folder">{t("macroChatNeedsFolder")}</div>
      </div>
    );
  }

  const header = (
    <div className="macro-chat__header">
      <div className="macro-chat__title-row">
        <span className="macro-chat__title">{t("macroChatTitle")}</span>
        <span className="macro-chat__file" title={filePath}>{fileName}</span>
        <button type="button" className="macro-chat__new-chat" onClick={handleNewChat}>
          {t("macroChatNewChat")}
        </button>
      </div>
      {lock.locked && (
        <div className="macro-chat__lock" role="alert">
          <span>{t("workbookLocked")}</span>
          <button type="button" onClick={checkLock}>{t("workbookLockRecheck")}</button>
        </div>
      )}
      {noMacros && <div className="macro-chat__no-macros">{t("macroChatNoMacros")}</div>}
      {listError && <div className="macro-chat__error">{listError}</div>}
      {list && (
        <div className="macro-chat__modules">
          <span className="macro-chat__modules-label">{t("macroChatModules")}</span>
          {list.modules.map((m) => (
            <span
              key={m.name}
              className={`macro-chat__module${m.path ? " macro-chat__module--extracted" : ""}`}
              title={m.path ? t("macroChatExtracted") : undefined}
            >
              {m.name} <small>{m.moduleType}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="macro-chat">
      <OpencodeChat variant="macro" header={header} placeholder={t("macroChatPlaceholder")} />
    </div>
  );
}
