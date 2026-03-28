import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useSlidevStore } from "@/stores/slidev-store";

interface SlidevPreviewPanelProps {
  content: string;
  filePath: string | null;
}

export function SlidevPreviewPanel({ content, filePath }: SlidevPreviewPanelProps) {
  const { t } = useTranslation("editor");
  const session = useSlidevStore((s) => filePath ? s.sessions[filePath] : undefined);
  const setSession = useSlidevStore((s) => s.setSession);
  const updateSession = useSlidevStore((s) => s.updateSession);
  const removeSession = useSlidevStore((s) => s.removeSession);
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePathRef = useRef(filePath);

  // Keep ref updated
  useEffect(() => { filePathRef.current = filePath; }, [filePath]);

  // Start Slidev dev server
  const startServer = useCallback(async () => {
    if (!filePath || !content) return;
    setStarting(true);
    try {
      const [tempDir, port] = await invoke<[string, number]>("slidev_start", {
        filePath,
        markdown: content,
      });
      setSession(filePath, { tempDir, port, ready: false });
    } catch (e) {
      if (filePath) {
        setSession(filePath, { tempDir: "", port: 0, ready: false, error: String(e) });
      }
    } finally {
      setStarting(false);
    }
  }, [filePath, content, setSession]);

  // Listen for server ready/error events
  // Rust emits: { "filePath": string, "port": number } and { "filePath": string, "error": string }
  useEffect(() => {
    const unlisten = listen<{ filePath: string; port: number }>("slidev-ready", (event) => {
      updateSession(event.payload.filePath, { ready: true });
    });
    const unlistenError = listen<{ filePath: string; error: string }>("slidev-error", (event) => {
      updateSession(event.payload.filePath, { error: event.payload.error });
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [updateSession]);

  // Auto-start on mount if no session
  useEffect(() => {
    if (filePath && !session) {
      startServer();
    }
  }, [filePath]); // intentionally minimal deps - only start when filePath changes

  // Sync content changes (debounced 500ms)
  useEffect(() => {
    if (!filePath || !session?.ready) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      invoke("slidev_sync", { filePath, markdown: content }).catch(console.warn);
    }, 500);
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [content, filePath, session?.ready]);

  // Stop server on unmount
  useEffect(() => {
    return () => {
      const fp = filePathRef.current;
      if (fp) {
        invoke("slidev_stop", { filePath: fp }).catch(console.warn);
        removeSession(fp);
      }
    };
  }, []); // cleanup on unmount only

  const handleExport = async (format: "pptx" | "pdf") => {
    if (!filePath) return;
    const ext = format === "pptx" ? "pptx" : "pdf";
    const outputPath = await save({
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!outputPath) return;
    setExporting(true);
    try {
      await invoke("slidev_export", { filePath, format, outputPath });
    } catch (e) {
      console.error("Export failed:", e);
    } finally {
      setExporting(false);
    }
  };

  if (!filePath) {
    return <div style={{ padding: 16, opacity: 0.5 }}>{t("slidevNoFile")}</div>;
  }

  if (starting || (session && !session.ready && !session.error)) {
    return (
      <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="slidev-spinner" />
        {t("slidevStarting")}
      </div>
    );
  }

  if (session?.error) {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ color: "var(--error)" }}>{t("slidevError")}: {session.error}</p>
        <button onClick={startServer} style={{ marginTop: 8 }}>{t("slidevRetry")}</button>
      </div>
    );
  }

  if (session?.ready) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="preview-panel__tabs">
          <span className="preview-panel__tab preview-panel__tab--active">Slidev</span>
          <div className="preview-panel__export-group">
            <button
              onClick={() => handleExport("pptx")}
              disabled={exporting}
            >
              {exporting ? "..." : "PPTX"}
            </button>
            <button
              onClick={() => handleExport("pdf")}
              disabled={exporting}
            >
              {exporting ? "..." : "PDF"}
            </button>
          </div>
        </div>
        <iframe
          src={`http://localhost:${session.port}`}
          style={{ flex: 1, border: "none", width: "100%" }}
          title="Slidev Preview"
        />
      </div>
    );
  }

  return null;
}
