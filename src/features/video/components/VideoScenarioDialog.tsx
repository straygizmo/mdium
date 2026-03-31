import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./VideoScenarioDialog.css";

export interface VideoScenarioParams {
  overwriteChoice: "overwrite" | "new";
  resolution: string;
  aspectRatio: string;
  sceneCount: "auto" | number;
  videoLength: "auto" | number;
  ttsSpeed: number;
}

interface VideoScenarioDialogProps {
  hasExisting: boolean;
  fileName: string;
  onSubmit: (params: VideoScenarioParams) => void;
  onCancel: () => void;
}

const RESOLUTION_OPTIONS: { value: string; label: string; aspect: string }[] = [
  { value: "1920x1080", label: "1920x1080", aspect: "16:9" },
  { value: "1080x1920", label: "1080x1920", aspect: "9:16" },
  { value: "1280x720", label: "1280x720", aspect: "16:9" },
  { value: "1080x1080", label: "1080x1080", aspect: "1:1" },
];

export function VideoScenarioDialog({
  hasExisting,
  fileName,
  onSubmit,
  onCancel,
}: VideoScenarioDialogProps) {
  const { t } = useTranslation("video");

  const [overwriteChoice, setOverwriteChoice] = useState<"overwrite" | "new">("overwrite");
  const [resolution, setResolution] = useState("1920x1080");
  const [sceneCountAuto, setSceneCountAuto] = useState(true);
  const [sceneCount, setSceneCount] = useState(5);
  const [videoLengthAuto, setVideoLengthAuto] = useState(true);
  const [videoLength, setVideoLength] = useState(30);
  const [ttsSpeed, setTtsSpeed] = useState(1.0);

  const aspectRatio = RESOLUTION_OPTIONS.find((o) => o.value === resolution)?.aspect ?? "16:9";

  const handleSubmit = useCallback(() => {
    onSubmit({
      overwriteChoice: hasExisting ? overwriteChoice : "overwrite",
      resolution,
      aspectRatio,
      sceneCount: sceneCountAuto ? "auto" : sceneCount,
      videoLength: videoLengthAuto ? "auto" : videoLength,
      ttsSpeed,
    });
  }, [hasExisting, overwriteChoice, resolution, aspectRatio, sceneCountAuto, sceneCount, videoLengthAuto, videoLength, ttsSpeed, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") handleSubmit();
    },
    [onCancel, handleSubmit],
  );

  return (
    <div className="video-scenario-overlay" onClick={onCancel}>
      <div
        className="video-scenario-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="video-scenario-dialog__title">
          {t("scenarioDialogTitle")}
        </h3>

        {hasExisting && (
          <div className="video-scenario-dialog__existing">
            <p className="video-scenario-dialog__existing-msg">
              {t("scenarioExistingFile", { fileName })}
            </p>
            <div className="video-scenario-dialog__radio-group">
              <label>
                <input
                  type="radio"
                  name="overwrite"
                  checked={overwriteChoice === "overwrite"}
                  onChange={() => setOverwriteChoice("overwrite")}
                />
                {t("scenarioOverwrite")}
              </label>
              <label>
                <input
                  type="radio"
                  name="overwrite"
                  checked={overwriteChoice === "new"}
                  onChange={() => setOverwriteChoice("new")}
                />
                {t("scenarioCreateNew")}
              </label>
            </div>
          </div>
        )}

        {/* Resolution */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioResolution")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            >
              {RESOLUTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({opt.aspect})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Scene Count */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioSceneCount")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <label className="video-scenario-dialog__auto-check">
              <input
                type="checkbox"
                checked={sceneCountAuto}
                onChange={(e) => setSceneCountAuto(e.target.checked)}
              />
              {t("scenarioSceneCountAuto")}
            </label>
            <input
              type="range"
              min={3}
              max={15}
              step={1}
              value={sceneCount}
              disabled={sceneCountAuto}
              onChange={(e) => setSceneCount(Number(e.target.value))}
            />
            <span className="video-scenario-dialog__field-value">
              {sceneCountAuto ? "—" : sceneCount}
            </span>
          </div>
        </div>

        {/* Video Length */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioVideoLength")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <label className="video-scenario-dialog__auto-check">
              <input
                type="checkbox"
                checked={videoLengthAuto}
                onChange={(e) => setVideoLengthAuto(e.target.checked)}
              />
              {t("scenarioVideoLengthAuto")}
            </label>
            <input
              type="range"
              min={20}
              max={150}
              step={10}
              value={videoLength}
              disabled={videoLengthAuto}
              onChange={(e) => setVideoLength(Number(e.target.value))}
            />
            <span className="video-scenario-dialog__field-value">
              {videoLengthAuto ? "—" : `${videoLength}${t("scenarioVideoLengthUnit")}`}
            </span>
          </div>
        </div>

        {/* TTS Speed */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioTtsSpeed")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <input
              type="range"
              min={0.7}
              max={1.5}
              step={0.1}
              value={ttsSpeed}
              onChange={(e) => setTtsSpeed(Number(e.target.value))}
            />
            <span className="video-scenario-dialog__field-value">
              {ttsSpeed.toFixed(1)}
            </span>
          </div>
        </div>

        <div className="video-scenario-dialog__actions">
          <button
            className="video-scenario-dialog__btn"
            onClick={onCancel}
          >
            {t("cancel")}
          </button>
          <button
            className="video-scenario-dialog__btn video-scenario-dialog__btn--primary"
            onClick={handleSubmit}
          >
            {t("scenarioStart")}
          </button>
        </div>
      </div>
    </div>
  );
}
