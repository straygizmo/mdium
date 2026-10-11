import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import type { FlowDef, FlowSummary } from "@/shared/types/flow";
import { emptyFlow } from "../lib/editor-state";

/** File names (without the suffix): lowercase letters, digits and hyphens. */
const FILE_NAME = /^[a-z0-9-]+$/;
/** Flow ids: letters, digits, underscores and hyphens. */
const FLOW_ID = /^[A-Za-z0-9_-]+$/;
const SUFFIX = ".flow.yaml";
const ENTRY_DIR = ".mdium/flows/";
const PART_DIR = ".mdium/flows/lib/";

type Location = "entry" | "part";

/** Project-relative path of a new flow file. */
export function newFlowPath(fileName: string, location: Location): string {
  return `${location === "part" ? PART_DIR : ENTRY_DIR}${fileName}${SUFFIX}`;
}

interface NewFlowDialogProps {
  /** Project folder the flow is created in. */
  projectRoot: string;
  /** Flow files already in the project; their paths are refused. */
  existing: FlowSummary[];
  onCreate(path: string, def: FlowDef): void;
  onClose(): void;
}

/** Asks for the file name, location, id and display name of a new flow. */
export function NewFlowDialog({ existing, onCreate, onClose }: NewFlowDialogProps) {
  const { t } = useTranslation("flow");
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState<Location>("entry");
  // `null` while the id follows the file name.
  const [flowId, setFlowId] = useState<string | null>(null);
  const [name, setName] = useState("");

  const id = flowId ?? fileName;
  const path = newFlowPath(fileName, location);
  const fileNameValid = FILE_NAME.test(fileName);
  const exists = fileNameValid && existing.some((f) => f.path.toLowerCase() === path.toLowerCase());
  const canCreate = fileNameValid && !exists && FLOW_ID.test(id);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canCreate) return;
    onCreate(path, emptyFlow(id, name.trim() || id));
  };

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog" labelledBy="flow-new-title" onClose={onClose}>
      <form className="flow-dialog__section" onSubmit={submit}>
        <h2 id="flow-new-title" className="flow-dialog__title">
          {t("editor.newFlow")}
        </h2>
        <label className="flow-dialog__field">
          <span className="flow-dialog__label">{t("editor.fileName")}</span>
          <input
            className="flow-dialog__input"
            aria-label={t("editor.fileName")}
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
          />
          <span className="flow-dialog__muted">{t("editor.fileNameHint")}</span>
        </label>
        <label className="flow-dialog__field">
          <span className="flow-dialog__label">{t("editor.location")}</span>
          <select
            className="flow-dialog__input"
            aria-label={t("editor.location")}
            value={location}
            onChange={(e) => setLocation(e.target.value === "part" ? "part" : "entry")}
          >
            <option value="entry">{t("editor.locationEntry")}</option>
            <option value="part">{t("editor.locationPart")}</option>
          </select>
        </label>
        <label className="flow-dialog__field">
          <span className="flow-dialog__label">{t("editor.flowId")}</span>
          <input
            className="flow-dialog__input"
            aria-label={t("editor.flowId")}
            value={id}
            onChange={(e) => setFlowId(e.target.value)}
          />
        </label>
        <label className="flow-dialog__field">
          <span className="flow-dialog__label">{t("editor.flowName")}</span>
          <input className="flow-dialog__input" aria-label={t("editor.flowName")} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {fileNameValid && <div className="flow-dialog__muted">{path}</div>}
        {exists && (
          <div className="flow-dialog__error" role="alert">
            {t("editor.fileExists")}
          </div>
        )}
        <div className="flow-dialog__footer">
          <button type="button" className="flow-dialog__button" onClick={onClose}>
            {t("editor.cancel")}
          </button>
          <button type="submit" className="flow-dialog__button flow-dialog__button--primary" disabled={!canCreate}>
            {t("editor.create")}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
