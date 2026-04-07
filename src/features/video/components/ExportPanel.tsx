import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { showConfirm } from "@/stores/dialog-store";
import { invoke } from "@tauri-apps/api/core";
import { useVideoStore } from "@/stores/video-store";

export interface ExportOptions {
  format: "mp4" | "webm";
  width: number;
  height: number;
  fps: number;
  concurrency: number;
  outputPath: string;
}

interface ExportPanelProps {
  disabled: boolean;
  onExport: (options: ExportOptions) => void;
}

const phaseKeys: Record<string, string> = {
  setup: "exportPhaseSetup",
  render: "exportPhaseRender",
  encode: "exportPhaseEncode",
  done: "exportPhaseDone",
};

export function ExportPanel({ disabled, onExport }: ExportPanelProps) {
  const { t } = useTranslation("video");
  const videoProject = useVideoStore((s) => s.videoProject);
  const renderProgress = useVideoStore((s) => s.renderProgress);
  const exportPhase = useVideoStore((s) => s.exportPhase);

  const meta = videoProject?.meta;

  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [fps, setFps] = useState(meta?.fps ?? 30);
  const [concurrency, setConcurrency] = useState(2);
  const sourceFilePath = useVideoStore((s) => s.sourceFilePath);

  const defaultOutputPath = useMemo(() => {
    if (!sourceFilePath) return "";
    return sourceFilePath.replace(/\.video\.json$/i, `.${format}`).replace(/\.md$/i, `.${format}`);
  }, [sourceFilePath, format]);

  const [outputPath, setOutputPath] = useState("");
  const effectiveOutputPath = outputPath || defaultOutputPath;

  const handleSelectOutputPath = useCallback(async () => {
    // Default: same directory, filename = {stem}.video.json → {stem}.mp4/webm
    let defaultPath = `output.${format}`;
    if (sourceFilePath) {
      defaultPath = sourceFilePath.replace(/\.video\.json$/i, `.${format}`).replace(/\.md$/i, `.${format}`);
    }
    const path = await save({
      filters: [
        {
          name: format === "mp4" ? "MP4 Video" : "WebM Video",
          extensions: [format],
        },
      ],
      defaultPath,
    });
    if (path) {
      setOutputPath(path);
    }
  }, [format, sourceFilePath]);

  const handleExport = useCallback(async () => {
    if (!effectiveOutputPath || !meta) return;
    const fileExists = await invoke<boolean>("video_file_exists", { path: effectiveOutputPath }).catch(() => false);
    if (fileExists) {
      const fileName = effectiveOutputPath.split(/[\\/]/).pop() ?? effectiveOutputPath;
      const confirmed = await showConfirm(t("exportFileExistsWarning", { fileName }), { kind: "warning" });
      if (!confirmed) return;
    }
    onExport({
      format,
      width: meta.width,
      height: meta.height,
      fps,
      concurrency,
      outputPath: effectiveOutputPath,
    });
  }, [format, fps, concurrency, effectiveOutputPath, meta, onExport, t]);

  const isExporting = exportPhase != null && exportPhase !== "done";
  const isDone = exportPhase === "done";

  return (
    <div className={`export-panel${disabled && !isExporting ? " export-panel--disabled" : ""}`}>
      <span className="export-panel__title">{t("exportDialog")}</span>

      <div className="export-panel__body">
        <div className="export-panel__field">
          <label>{t("format")}</label>
          <div className="export-panel__radios">
            <label>
              <input
                type="radio"
                name="format"
                value="mp4"
                checked={format === "mp4"}
                onChange={() => setFormat("mp4")}
                disabled={disabled}
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
                disabled={disabled}
              />
              WebM
            </label>
          </div>
        </div>

        <div className="export-panel__field">
          <label>{t("resolution")}</label>
          <span className="export-panel__value">
            {meta?.width ?? "\u2014"} x {meta?.height ?? "\u2014"}
          </span>
        </div>

        <div className="export-panel__field">
          <label>{t("fps")}</label>
          <input
            type="number"
            min={1}
            max={120}
            value={fps}
            onChange={(e) => setFps(parseInt(e.target.value, 10) || 30)}
            disabled={disabled}
          />
        </div>

        <div className="export-panel__field">
          <label>{t("concurrency")}</label>
          <input
            type="number"
            min={1}
            max={16}
            value={concurrency}
            onChange={(e) => setConcurrency(parseInt(e.target.value, 10) || 1)}
            disabled={disabled}
          />
        </div>

        <div className="export-panel__field">
          <label>{t("outputPath")}</label>
          <button
            className="export-panel__path-btn"
            onClick={handleSelectOutputPath}
            disabled={disabled}
          >
            {effectiveOutputPath ? effectiveOutputPath.split(/[\\/]/).pop() : t("selectOutput")}
          </button>
        </div>

        {(isExporting || isDone) && (
          <div className="export-panel__status">
            <div className="export-panel__progress">
              <div
                className={`export-panel__progress-bar${isDone ? " export-panel__progress-bar--done" : ""}`}
                style={{ width: `${Math.round(renderProgress)}%` }}
              />
              <span>
                {exportPhase && phaseKeys[exportPhase]
                  ? t(phaseKeys[exportPhase])
                  : ""}{" "}
                {renderProgress > 0 ? `${Math.round(renderProgress)}%` : ""}
              </span>
            </div>
          </div>
        )}

        <button
          className="export-panel__export-btn"
          onClick={handleExport}
          disabled={disabled || !effectiveOutputPath || isExporting}
        >
          {isExporting ? t("exporting") : t("startExport")}
        </button>
      </div>
    </div>
  );
}
