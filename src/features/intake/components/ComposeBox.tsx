import { type ClipboardEvent, type KeyboardEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import type { IntakeSessionView } from "@/shared/types/workflow";
import { useSpeechToText } from "@/features/speech/hooks/useSpeechToText";
import { useSettingsStore } from "@/stores/settings-store";
import { useIntakeStore } from "../intake-store";
import "./ComposeBox.css";

interface ComposeBoxProps {
  session: IntakeSessionView;
  /** Drafts sent with the message. */
  pendingDraftIds: string[];
}

/** Reads a file as base64 (without the data URL prefix). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The message input. Enter inserts a newline and Ctrl+Enter sends; pasted
 * images and files chosen with "attach" become drafts. It stays visible
 * after errors so the user can always answer again.
 */
export function ComposeBox({ session, pendingDraftIds }: ComposeBoxProps) {
  const { t } = useTranslation("workflow");
  const send = useIntakeStore((s) => s.send);
  const sending = useIntakeStore((s) => s.sending);
  const addDraftFromPath = useIntakeStore((s) => s.addDraftFromPath);
  const addDraftFromBytes = useIntakeStore((s) => s.addDraftFromBytes);
  const speechEnabled = useSettingsStore((s) => s.speechEnabled);
  const speechModel = useSettingsStore((s) => s.speechModel);
  const { status: speechStatus, transcript, toggle: toggleSpeech, setTranscript } = useSpeechToText(speechModel);
  const [text, setText] = useState("");
  const [attaching, setAttaching] = useState(false);

  const active = session.status === "active";
  const canSend = active && !session.busy && !sending && (text.trim() !== "" || pendingDraftIds.length > 0);

  useEffect(() => {
    if (!transcript) return;
    setText((prev) => prev + transcript);
    setTranscript("");
  }, [transcript, setTranscript]);

  const submit = async () => {
    // `send` also refuses while a send is in flight.
    if (!canSend) return;
    const ok = await send(text, pendingDraftIds);
    if (ok) setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !active) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    // Text paste keeps the default behavior.
    if (files.length === 0) return;
    e.preventDefault();
    void (async () => {
      for (const file of files) {
        const ext = file.type.split("/")[1] || "png";
        try {
          await addDraftFromBytes(file.name || `image.${ext}`, await readBase64(file));
        } catch (err) {
          console.error("[intake] reading a pasted image failed", err);
        }
      }
    })();
  };

  const onAttach = async () => {
    if (attaching) return;
    setAttaching(true);
    try {
      const picked = await open({ multiple: true });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      for (const path of paths) await addDraftFromPath(path);
    } catch (err) {
      console.error("[intake] choosing files failed", err);
    } finally {
      setAttaching(false);
    }
  };

  const recording = speechStatus === "recording";

  return (
    <div className="intake-compose">
      <textarea
        className="intake-compose__input"
        aria-label={t("intake.compose.label")}
        placeholder={t("intake.compose.placeholder")}
        title={t("intake.compose.pasteHint")}
        rows={3}
        value={text}
        disabled={!active}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="intake-compose__actions">
        <button
          type="button"
          className="intake-compose__attach"
          onClick={() => void onAttach()}
          disabled={!active || attaching}
        >
          {t("intake.compose.attach")}
        </button>
        {speechEnabled && (
          <button
            type="button"
            className={`intake-compose__voice${recording ? " intake-compose__voice--recording" : ""}`}
            aria-label={recording ? t("intake.compose.voiceStop") : t("intake.compose.voice")}
            title={recording ? t("intake.compose.voiceStop") : t("intake.compose.voice")}
            aria-pressed={recording}
            onClick={toggleSpeech}
            disabled={!active || speechStatus === "loading" || speechStatus === "transcribing"}
          >
            {recording ? t("intake.compose.voiceStop") : t("intake.compose.voice")}
          </button>
        )}
        <button type="button" className="intake-compose__send" onClick={() => void submit()} disabled={!canSend}>
          {sending ? t("intake.compose.sending") : t("intake.compose.send")}
        </button>
      </div>
    </div>
  );
}
