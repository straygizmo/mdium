import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import { useFtpBrowserStore } from "@/stores/ftp-browser-store";
import { useFtpMirrorStore } from "@/stores/ftp-mirror-store";
import type { FileEntry } from "@/shared/types";
import { FtpConnectDialog, connectionKey, type SavedConnection } from "./FtpConnectDialog";
import "../../table/components/ContextMenu.css";
import "@/features/file-tree/components/FileTree.css";
import "./FtpPanel.css";

interface FtpPanelProps {
  /**
   * Called once the folder `uri` has been mirrored locally to `root`; opens
   * it as a working folder tab.
   */
  onOpenWorkingFolder: (uri: string, root: string) => void;
}

type MenuTarget =
  | { kind: "connection"; connection: SavedConnection }
  | { kind: "dir"; uri: string };

interface MenuState {
  x: number;
  y: number;
  target: MenuTarget;
}

/** Display name of the tree root: the remote path it points at. */
function rootLabel(uri: string): string {
  const rest = uri.replace(/^ftp:\/\/[^/]*/, "");
  return rest === "" ? "/" : rest;
}

export function FtpPanel({ onOpenWorkingFolder }: FtpPanelProps) {
  const { t } = useTranslation("remote");
  const recent = useFtpBrowserStore((s) => s.recent);
  const connection = useFtpBrowserStore((s) => s.connection);
  const setConnected = useFtpBrowserStore((s) => s.setConnected);
  const disconnect = useFtpBrowserStore((s) => s.disconnect);
  const forget = useFtpBrowserStore((s) => s.forget);
  const refresh = useFtpBrowserStore((s) => s.refresh);

  const [saved, setSaved] = useState<SavedConnection[]>([]);
  // undefined: dialog closed; null: new connection; string: edit that one.
  const [dialogKey, setDialogKey] = useState<string | null | undefined>(undefined);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [openingUri, setOpeningUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const mirrorProgress = useFtpMirrorStore((s) =>
    openingUri ? Object.values(s.statuses).find((st) => st.uri === openingUri)?.progress ?? null : null,
  );

  const loadSaved = useCallback(() => {
    invoke<SavedConnection[]>("ftp_list_connections")
      .then(setSaved)
      .catch(() => setSaved([]));
  }, []);

  useEffect(loadSaved, [loadSaved]);

  // Most recently used first, then the rest in the backend's order.
  const ordered = useMemo(() => {
    const rank = (c: SavedConnection) => {
      const i = recent.indexOf(connectionKey(c));
      return i === -1 ? recent.length : i;
    };
    return [...saved].sort((a, b) => rank(a) - rank(b));
  }, [saved, recent]);

  const connect = useCallback(
    async (c: SavedConnection) => {
      const key = connectionKey(c);
      if (!c.hasPassword) {
        setDialogKey(key);
        return;
      }
      setConnectingKey(key);
      setError(null);
      try {
        const { hasPassword: _hasPassword, ...profile } = c;
        const remotePath = useFtpBrowserStore.getState().rootPaths[key] || "/";
        const uri = await invoke<string>("ftp_connect", { profile, password: null, remotePath });
        setConnected(key, uri, remotePath);
      } catch (e) {
        setError(t("connectError", { error: String(e) }));
      } finally {
        setConnectingKey(null);
      }
    },
    [setConnected, t],
  );

  const deleteConnection = useCallback(
    async (c: SavedConnection) => {
      const key = connectionKey(c);
      const ok = await showConfirm(t("deleteConfirm", { name: key }), { kind: "warning" });
      if (!ok) return;
      try {
        await invoke("ftp_delete_connection", { profile: c });
        forget(key);
        loadSaved();
      } catch (e) {
        setError(String(e));
      }
    },
    [forget, loadSaved, t],
  );

  // Mirror the folder locally (initial sync included) and open it in a tab,
  // the same way an FTP folder has always been opened.
  const openWorkingFolder = useCallback(
    async (uri: string) => {
      setOpeningUri(uri);
      setError(null);
      try {
        const root = await useFtpMirrorStore.getState().open(uri);
        onOpenWorkingFolder(uri, root);
      } catch (e) {
        setError(t("openRecentFailed", { error: String(e) }));
      } finally {
        setOpeningUri(null);
      }
    },
    [onOpenWorkingFolder, t],
  );

  // Close the context menu on an outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  // Keep the context menu inside the viewport.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const margin = 4;
    setMenuPos({
      x: Math.max(margin, Math.min(menu.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(menu.y, window.innerHeight - rect.height - margin)),
    });
  }, [menu]);

  const openMenu = (e: React.MouseEvent, target: MenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const runMenu = (action: () => void) => {
    setMenu(null);
    action();
  };

  const busy = openingUri !== null;

  return (
    <div className="ftp-panel">
      <div className="ftp-panel__section">
        <div className="ftp-panel__section-title">
          <span>{t("recentConnections")}</span>
          <button
            className="left-panel__header-action"
            onClick={() => setDialogKey(null)}
            title={t("newConnection")}
            aria-label={t("newConnection")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div className="ftp-panel__connections">
          {ordered.length === 0 && <div className="ftp-panel__note">{t("noConnections")}</div>}
          {ordered.map((c) => {
            const key = connectionKey(c);
            return (
              <div
                key={key}
                className={`file-tree__node ${connection?.key === key ? "file-tree__node--active" : ""}`}
                data-connection={key}
                onClick={() => !busy && connect(c)}
                onContextMenu={(e) => openMenu(e, { kind: "connection", connection: c })}
                title={key}
              >
                <span className="file-tree__icon">{c.secure ? "🔒" : "🌐"}</span>
                <span className="file-tree__name">{key}</span>
                {connectingKey === key && <span className="ftp-panel__muted">{t("connecting")}</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="ftp-panel__section ftp-panel__section--tree">
        <div className="ftp-panel__section-title">
          <span className="ftp-panel__tree-title">{connection ? connection.key : t("serverFolders")}</span>
          {connection && (
            <span className="ftp-panel__actions">
              <button className="left-panel__header-action" onClick={() => refresh()} title={t("refresh")} aria-label={t("refresh")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
              <button className="left-panel__header-action" onClick={disconnect} title={t("disconnect")} aria-label={t("disconnect")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          )}
        </div>
        {connection ? (
          <div className="file-tree__list">
            <RemoteNode
              entry={{ name: rootLabel(connection.uri), path: connection.uri, is_dir: true, children: null }}
              depth={0}
              onDirContextMenu={(e, uri) => openMenu(e, { kind: "dir", uri })}
            />
          </div>
        ) : (
          <div className="ftp-panel__note">{t("notConnected")}</div>
        )}
        {connection && <div className="ftp-panel__note ftp-panel__hint">{t("treeHint")}</div>}
      </div>

      {openingUri && (
        <div className="ftp-panel__status">
          {mirrorProgress
            ? t("mirroringProgress", { done: mirrorProgress.done, total: mirrorProgress.total })
            : t("mirroring")}
        </div>
      )}
      {error && <div className="ftp-panel__error">{error}</div>}

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menuPos?.x ?? menu.x, top: menuPos?.y ?? menu.y }}
        >
          {menu.target.kind === "dir" ? (
            <div className="ctx-group">
              <button
                disabled={busy}
                onClick={() => {
                  const { uri } = menu.target as { uri: string };
                  runMenu(() => openWorkingFolder(uri));
                }}
              >
                <span className="ctx-label">{t("openAsWorkingFolder")}</span>
              </button>
            </div>
          ) : (
            <div className="ctx-group">
              <button
                disabled={busy}
                onClick={() => {
                  const c = (menu.target as { connection: SavedConnection }).connection;
                  runMenu(() => connect(c));
                }}
              >
                <span className="ctx-label">{t("connectAction")}</span>
              </button>
              <button
                onClick={() => {
                  const c = (menu.target as { connection: SavedConnection }).connection;
                  runMenu(() => setDialogKey(connectionKey(c)));
                }}
              >
                <span className="ctx-label">{t("editConnection")}</span>
              </button>
              <button
                onClick={() => {
                  const c = (menu.target as { connection: SavedConnection }).connection;
                  runMenu(() => deleteConnection(c));
                }}
              >
                <span className="ctx-label">{t("deleteConnection")}</span>
              </button>
            </div>
          )}
        </div>
      )}

      <FtpConnectDialog
        open={dialogKey !== undefined}
        initialKey={dialogKey}
        onClose={() => {
          setDialogKey(undefined);
          loadSaved();
        }}
        onConnected={(key, uri, remotePath) => setConnected(key, uri, remotePath)}
        onDeleted={forget}
      />
    </div>
  );
}

interface RemoteNodeProps {
  entry: FileEntry;
  depth: number;
  onDirContextMenu: (e: React.MouseEvent, uri: string) => void;
}

function RemoteNode({ entry, depth, onDirContextMenu }: RemoteNodeProps) {
  const { t } = useTranslation("remote");
  const expanded = useFtpBrowserStore((s) => !!s.expanded[entry.path]);
  const children = useFtpBrowserStore((s) => s.children[entry.path]);
  const loading = useFtpBrowserStore((s) => !!s.loading[entry.path]);
  const error = useFtpBrowserStore((s) => s.errors[entry.path]);
  const toggle = useFtpBrowserStore((s) => s.toggle);
  const indent = { paddingLeft: `${depth * 16 + 8}px` };
  const childIndent = { paddingLeft: `${(depth + 1) * 16 + 8}px` };

  if (!entry.is_dir) {
    return (
      <div className="file-tree__node ftp-panel__file" style={indent} data-path={entry.path} title={entry.name}>
        <span className="file-tree__icon">📄</span>
        <span className="file-tree__name">{entry.name}</span>
      </div>
    );
  }

  return (
    <>
      <div
        className="file-tree__node"
        style={indent}
        data-path={entry.path}
        onClick={() => toggle(entry.path)}
        onContextMenu={(e) => onDirContextMenu(e, entry.path)}
        title={entry.name}
      >
        <span className="file-tree__icon">{expanded ? "📂" : "📁"}</span>
        <span className="file-tree__name">{entry.name}</span>
      </div>
      {expanded && (
        <div className="file-tree__children">
          {loading && !children && (
            <div className="ftp-panel__note" style={childIndent}>{t("loading")}</div>
          )}
          {error && (
            <div className="ftp-panel__error" style={childIndent}>{t("listError", { error })}</div>
          )}
          {children?.length === 0 && (
            <div className="ftp-panel__note" style={childIndent}>{t("emptyFolder")}</div>
          )}
          {children?.map((child) => (
            <RemoteNode key={child.path} entry={child} depth={depth + 1} onDirContextMenu={onDirContextMenu} />
          ))}
        </div>
      )}
    </>
  );
}
