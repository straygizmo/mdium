import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artifact } from "@/shared/types/flow-run";
import { artifactKind, fetchTextHead, prettyJson, TEXT_PREVIEW_BYTES } from "../lib/artifact-kind";
import { flowRunApi } from "../lib/flow-run-api";

interface ArtifactPreviewProps {
  projectRoot: string;
  runId: string;
  nodeKey: string;
  attempt: number;
  artifact: Artifact;
}

type PreviewState =
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "ready"; url: string; text?: string; truncated?: boolean };

/** Inline preview of one recorded artifact (image, video, audio, text or JSON). */
export function ArtifactPreview({ projectRoot, runId, nodeKey, attempt, artifact }: ArtifactPreviewProps) {
  const { t } = useTranslation("flow");
  const [state, setState] = useState<PreviewState>({ phase: "loading" });
  const kind = artifactKind(artifact.mediaType);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    (async () => {
      try {
        const url = await flowRunApi.artifactUrl(projectRoot, { runId, nodeKey, attempt, index: artifact.index });
        if ((kind === "text" || kind === "json") && artifact.bytes === 0) {
          // An empty file cannot be range-read (the asset protocol answers 416), and there is nothing to show.
          if (!cancelled) setState({ phase: "ready", url, text: "" });
        } else if (kind === "text" || kind === "json") {
          const head = await fetchTextHead(url);
          const text = kind === "json" && !head.truncated ? (prettyJson(head.text) ?? head.text) : head.text;
          if (!cancelled) setState({ phase: "ready", url, text, truncated: head.truncated });
        } else if (!cancelled) {
          setState({ phase: "ready", url });
        }
      } catch {
        if (!cancelled) setState({ phase: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoot, runId, nodeKey, attempt, artifact.index, artifact.bytes, kind]);

  if (state.phase === "failed") return <div className="flow-run__muted">{t("run.previewUnavailable")}</div>;
  if (state.phase === "loading") return null;
  const alt = artifact.label ?? artifact.path;
  // A recorded file may be missing or unreadable: the media element then reports an error.
  const onMediaError = () => setState({ phase: "failed" });
  return (
    <div className="flow-artifact__preview">
      {kind === "image" && <img className="flow-artifact__media" src={state.url} alt={alt} onError={onMediaError} />}
      {kind === "video" && <video className="flow-artifact__media" controls src={state.url} onError={onMediaError} />}
      {kind === "audio" && <audio controls src={state.url} onError={onMediaError} />}
      {(kind === "text" || kind === "json") && (
        <>
          <pre className="flow-artifact__text">{state.text}</pre>
          {state.truncated && <div className="flow-run__muted">{t("run.previewTruncated", { kib: TEXT_PREVIEW_BYTES / 1024 })}</div>}
        </>
      )}
      {kind === "other" && (
        <div className="flow-run__muted">
          {t("run.previewNone")} <code>{artifact.path}</code>
        </div>
      )}
    </div>
  );
}
