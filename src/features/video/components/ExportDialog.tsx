import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { useVideoStore } from "@/stores/video-store";

export interface ExportOptions {
  format: "mp4" | "webm";
  width: number;
  height: number;
  fps: number;
  concurrency: number;
  outputPath: string;
}

interface ExportDialogProps {
  onClose: () => void;
  onExport: (options: ExportOptions) => void;
}

export function ExportDialog({ onClose, onExport }: ExportDialogProps) {
  const { t } = useTranslation("video");
  const videoProject = useVideoStore((s) => s.videoProject);
  const renderProgress = useVideoStore((s) => s.renderProgress);

  const meta = videoProject?.meta;

  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [fps, setFps] = useState(meta?.fps ?? 30);
  const [concurrency, setConcurrency] = useState(2);
  const [outputPath, setOutputPath] = useState("");

  const handleSelectOutputPath = useCallback(async () => {
    const path = await save({
      filters: [
        {
          name: format === "mp4" ? "MP4 Video" : "WebM Video",
          extensions: [format],
        },
      ],
      defaultPath: `output.${format}`,
    });
    if (path) {
      setOutputPath(path);
    }
  }, [format]);

  const handleExport = useCallback(() => {
    if (!outputPath || !meta) return;
    onExport({
      format,
      width: meta.width,
      height: meta.height,
      fps,
      concurrency,
      outputPath,
    });
  }, [format, fps, concurrency, outputPath, meta, onExport]);

  const isExporting = renderProgress > 0 && renderProgress < 1;

  return (
    <div className="export-dialog__overlay" onClick={onClose}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t("export.title")}</h2>

        <div className="export-dialog__field">
          <label>{t("export.format")}</label>
          <label>
            <input
              type="radio"
              name="format"
              value="mp4"
              checked={format === "mp4"}
              onChange={() => setFormat("mp4")}
            />
            MP4
          </label>
          <label>
            <input
              type="radio"
              name="format"
              value="webm"
              checked={format === "webm"}
              onChange={() => setFormat("webm")}
            />
            WebM
          </label>
        </div>

        <div className="export-dialog__field">
          <label>{t("export.resolution")}</label>
          <span>
            {meta?.width ?? "—"} x {meta?.height ?? "—"}
          </span>
        </div>

        <div className="export-dialog__field">
          <label>{t("export.fps")}</label>
          <input
            type="number"
            min={1}
            max={120}
            value={fps}
            onChange={(e) => setFps(parseInt(e.target.value, 10) || 30)}
          />
        </div>

        <div className="export-dialog__field">
          <label>{t("export.concurrency")}</label>
          <input
            type="number"
            min={1}
            max={16}
            value={concurrency}
            onChange={(e) => setConcurrency(parseInt(e.target.value, 10) || 1)}
          />
        </div>

        <div className="export-dialog__field">
          <label>{t("export.outputPath")}</label>
          <button onClick={handleSelectOutputPath}>
            {outputPath ? outputPath.split(/[\\/]/).pop() : t("export.selectOutput")}
          </button>
        </div>

        {isExporting && (
          <div className="export-dialog__progress">
            <div
              className="export-dialog__progress-bar"
              style={{ width: `${Math.round(renderProgress * 100)}%` }}
            />
            <span>{Math.round(renderProgress * 100)}%</span>
          </div>
        )}

        <div className="export-dialog__actions">
          <button onClick={onClose} disabled={isExporting}>
            {t("export.cancel")}
          </button>
          <button onClick={handleExport} disabled={!outputPath || isExporting}>
            {t("export.export")}
          </button>
        </div>
      </div>
    </div>
  );
}
