import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import { useFtpMirrorStore } from "@/stores/ftp-mirror-store";
import "./FtpConnectDialog.css";

interface FtpProfile {
  host: string;
  port: number;
  user: string;
  secure: boolean;
  acceptInvalidCerts: boolean;
}

interface SavedConnection extends FtpProfile {
  hasPassword: boolean;
}

interface FtpConnectDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called after login and the initial sync with the folder URI
   * (ftp://user@host:port/path) and the local mirror folder to open.
   */
  onConnected: (uri: string, root: string) => void;
}

const DEFAULT_PORT = 21;

function connectionKey(c: FtpProfile): string {
  return `${c.user}@${c.host}:${c.port}`;
}

export function FtpConnectDialog({ open: isOpen, onClose, onConnected }: FtpConnectDialogProps) {
  const { t } = useTranslation("remote");
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [remotePath, setRemotePath] = useState("/");
  const [secure, setSecure] = useState(true);
  const [acceptInvalidCerts, setAcceptInvalidCerts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once logged in, while the folder is being synced locally.
  const [mirroringUri, setMirroringUri] = useState<string | null>(null);
  const mirrorProgress = useFtpMirrorStore((s) =>
    mirroringUri ? Object.values(s.statuses).find((st) => st.uri === mirroringUri)?.progress ?? null : null,
  );

  const selected = saved.find((c) => connectionKey(c) === selectedKey) ?? null;

  const applyConnection = (c: SavedConnection | null) => {
    setSelectedKey(c ? connectionKey(c) : "");
    setHost(c?.host ?? "");
    setPort(String(c?.port ?? DEFAULT_PORT));
    setUser(c?.user ?? "");
    setSecure(c?.secure ?? true);
    setAcceptInvalidCerts(c?.acceptInvalidCerts ?? false);
    setPassword("");
    setError(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    invoke<SavedConnection[]>("ftp_list_connections")
      .then((list) => {
        setSaved(list);
        if (list.length > 0) applyConnection(list[0]);
      })
      .catch(() => setSaved([]));
  }, [isOpen]);

  const resetAndClose = () => {
    if (loading) return;
    setPassword("");
    setError(null);
    onClose();
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) resetAndClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, loading]);

  if (!isOpen) return null;

  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536;
  // A saved connection with a stored password may leave the field empty,
  // as long as host / user / port still match it.
  const reusesStoredPassword =
    !!selected && selected.hasPassword &&
    selected.host === host.trim() && selected.user === user.trim() && selected.port === portNumber;
  const canConnect =
    host.trim() !== "" && user.trim() !== "" && portValid &&
    (password !== "" || reusesStoredPassword) && !loading;

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const profile: FtpProfile = {
        host: host.trim(),
        port: portNumber,
        user: user.trim(),
        secure,
        acceptInvalidCerts: secure && acceptInvalidCerts,
      };
      const uri = await invoke<string>("ftp_connect", {
        profile,
        password: password === "" ? null : password,
        remotePath: remotePath.trim() || "/",
      });
      setPassword("");
      setMirroringUri(uri);
      const root = await useFtpMirrorStore.getState().open(uri);
      onConnected(uri, root);
      onClose();
    } catch (e) {
      setError(t("connectError", { error: String(e) }));
    } finally {
      setLoading(false);
      setMirroringUri(null);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const ok = await showConfirm(t("deleteConfirm", { name: connectionKey(selected) }), { kind: "warning" });
    if (!ok) return;
    try {
      await invoke("ftp_delete_connection", { profile: selected });
      const rest = saved.filter((c) => connectionKey(c) !== selectedKey);
      setSaved(rest);
      applyConnection(rest[0] ?? null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="ftp-dialog__overlay" onMouseDown={resetAndClose}>
      <div className="ftp-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="ftp-dialog__title">{t("openFtpFolder")}</h2>
        <div className="ftp-dialog__note ftp-dialog__intro">{t("mirrorExplain")}</div>

        {saved.length > 0 && (
          <div className="ftp-dialog__field">
            <label className="ftp-dialog__label">{t("savedConnection")}</label>
            <div className="ftp-dialog__row">
              <select
                className="ftp-dialog__input"
                value={selectedKey}
                onChange={(e) => applyConnection(saved.find((c) => connectionKey(c) === e.target.value) ?? null)}
                disabled={loading}
              >
                <option value="">{t("newConnection")}</option>
                {saved.map((c) => (
                  <option key={connectionKey(c)} value={connectionKey(c)}>
                    {connectionKey(c)}
                  </option>
                ))}
              </select>
              {selected && (
                <button className="ftp-dialog__btn" onClick={handleDelete} disabled={loading} title={t("deleteConnection")}>
                  {t("deleteConnection")}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="ftp-dialog__row">
          <div className="ftp-dialog__field ftp-dialog__field--grow">
            <label className="ftp-dialog__label">{t("host")}</label>
            <input
              className="ftp-dialog__input"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="ftp.example.com"
              disabled={loading}
              autoFocus
            />
          </div>
          <div className="ftp-dialog__field ftp-dialog__field--port">
            <label className="ftp-dialog__label">{t("port")}</label>
            <input
              className="ftp-dialog__input"
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={loading}
            />
          </div>
        </div>

        <div className="ftp-dialog__field">
          <label className="ftp-dialog__label">{t("user")}</label>
          <input
            className="ftp-dialog__input"
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="ftp-dialog__field">
          <label className="ftp-dialog__label">{t("password")}</label>
          <input
            className="ftp-dialog__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={reusesStoredPassword ? t("passwordSavedPlaceholder") : ""}
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && canConnect) handleConnect();
            }}
          />
          <div className="ftp-dialog__note">{t("passwordNote")}</div>
        </div>

        <div className="ftp-dialog__field">
          <label className="ftp-dialog__label">{t("remotePath")}</label>
          <input
            className="ftp-dialog__input"
            type="text"
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="/public_html"
            disabled={loading}
          />
        </div>

        <label className="ftp-dialog__check">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} disabled={loading} />
          {t("secure")}
        </label>
        {secure ? (
          <label className="ftp-dialog__check">
            <input
              type="checkbox"
              checked={acceptInvalidCerts}
              onChange={(e) => setAcceptInvalidCerts(e.target.checked)}
              disabled={loading}
            />
            {t("acceptInvalidCerts")}
          </label>
        ) : (
          <div className="ftp-dialog__warning">{t("plainWarning")}</div>
        )}

        {loading && (
          <div className="ftp-dialog__status">
            {!mirroringUri
              ? t("connecting")
              : mirrorProgress
                ? t("mirroringProgress", { done: mirrorProgress.done, total: mirrorProgress.total })
                : t("mirroring")}
          </div>
        )}
        {error && <div className="ftp-dialog__error">{error}</div>}

        <div className="ftp-dialog__actions">
          <button className="ftp-dialog__btn" onClick={resetAndClose} disabled={loading}>
            {t("cancel")}
          </button>
          <button
            className="ftp-dialog__btn ftp-dialog__btn--primary"
            onClick={handleConnect}
            disabled={!canConnect}
          >
            {t("connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
