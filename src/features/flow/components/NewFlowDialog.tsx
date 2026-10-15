import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import type { FlowDef, FlowSummary, FlowTemplateInfo } from "@/shared/types/flow";
import { emptyFlow } from "../lib/editor-state";
import { flowApi } from "../lib/flow-api";

/** Flow ids: lowercase letters, digits and hyphens, not starting with a hyphen (validate.rs `is_flow_id`). */
const FLOW_ID = /^[a-z0-9][a-z0-9-]*$/;
/** File names (without the suffix): the same rule, since the id follows the file name. */
const FILE_NAME = FLOW_ID;
const SUFFIX = ".flow.yaml";
const ENTRY_DIR = ".mdium/flows/";
const PART_DIR = ".mdium/flows/lib/";

type Location = "entry" | "part";
type Source = "blank" | "template";

/** Project-relative path of a new flow file. */
export function newFlowPath(fileName: string, location: Location): string {
  return `${location === "part" ? PART_DIR : ENTRY_DIR}${fileName}${SUFFIX}`;
}

interface NewFlowDialogProps {
  /** The open project (templates are listed through it). */
  projectRoot: string;
  /** Flow files already in the project; their paths are refused. */
  existing: FlowSummary[];
  onCreate(path: string, def: FlowDef): void;
  /** Copies the built-in template `template` into the project as `<fileName>.flow.yaml`. */
  onCreateFromTemplate(template: string, fileName: string): void;
  onClose(): void;
}

/**
 * Asks for the file name, location, id and display name of a new blank flow,
 * or for a built-in template and the file name of its copy.
 */
export function NewFlowDialog({ projectRoot, existing, onCreate, onCreateFromTemplate, onClose }: NewFlowDialogProps) {
  const { t, i18n } = useTranslation("flow");
  const [source, setSource] = useState<Source>("blank");
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState<Location>("entry");
  // `null` while the id follows the file name.
  const [flowId, setFlowId] = useState<string | null>(null);
  const [name, setName] = useState("");
  // `null` until the templates were listed.
  const [templates, setTemplates] = useState<FlowTemplateInfo[] | null>(null);
  const [template, setTemplate] = useState("");
  // `null` while the template copy's file name follows the template name.
  const [copyName, setCopyName] = useState<string | null>(null);

  // Templates are listed the first time the template mode is chosen.
  useEffect(() => {
    if (source !== "template" || templates !== null) return;
    let cancelled = false;
    flowApi
      .listTemplates(projectRoot)
      .then((list) => list ?? [])
      .catch(() => [] as FlowTemplateInfo[])
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        setTemplate((current) => current || list[0]?.name || "");
      });
    return () => {
      cancelled = true;
    };
  }, [source, templates, projectRoot]);

  const isTemplate = source === "template";
  const targetName = isTemplate ? (copyName ?? template) : fileName;
  const id = flowId ?? fileName;
  const path = newFlowPath(targetName, isTemplate ? "entry" : location);
  const fileNameValid = FILE_NAME.test(targetName);
  const exists = fileNameValid && existing.some((f) => f.path.toLowerCase() === path.toLowerCase());
  const canCreate = isTemplate
    ? template !== "" && fileNameValid && !exists
    : fileNameValid && !exists && FLOW_ID.test(id);
  const chosen = templates?.find((tpl) => tpl.name === template);

  /** The localized title / description of a template, else its own. */
  const templateText = (tpl: FlowTemplateInfo, field: "title" | "description") => {
    const key = `template.${tpl.name}.${field}`;
    return i18n.exists(key, { ns: "flow" }) ? t(key) : tpl[field];
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canCreate) return;
    if (isTemplate) onCreateFromTemplate(template, targetName);
    else onCreate(path, emptyFlow(id, name.trim() || id));
  };

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog" labelledBy="flow-new-title" onClose={onClose}>
      <form className="flow-dialog__section" onSubmit={submit}>
        <h2 id="flow-new-title" className="flow-dialog__title">
          {t("editor.newFlow")}
        </h2>
        <fieldset className="flow-dialog__field">
          <legend className="flow-dialog__label">{t("newFlow.source")}</legend>
          {(["blank", "template"] as const).map((s) => (
            <label key={s}>
              <input type="radio" name="flow-new-source" checked={source === s} onChange={() => setSource(s)} />
              <span>{t(s === "blank" ? "newFlow.sourceBlank" : "newFlow.sourceTemplate")}</span>
            </label>
          ))}
        </fieldset>
        {isTemplate ? (
          <>
            <label className="flow-dialog__field">
              <span className="flow-dialog__label">{t("newFlow.template")}</span>
              <select
                className="flow-dialog__input"
                aria-label={t("newFlow.template")}
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                disabled={!templates || templates.length === 0}
              >
                {(templates ?? []).map((tpl) => (
                  <option key={tpl.name} value={tpl.name}>
                    {templateText(tpl, "title")}
                  </option>
                ))}
              </select>
              {chosen && <span className="flow-dialog__muted">{templateText(chosen, "description")}</span>}
            </label>
            {templates && templates.length === 0 && <div className="flow-dialog__muted">{t("newFlow.noTemplates")}</div>}
            <label className="flow-dialog__field">
              <span className="flow-dialog__label">{t("editor.fileName")}</span>
              <input
                className="flow-dialog__input"
                aria-label={t("editor.fileName")}
                value={targetName}
                onChange={(e) => setCopyName(e.target.value)}
              />
              <span className="flow-dialog__muted">{t("editor.fileNameHint")}</span>
            </label>
          </>
        ) : (
          <>
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
          </>
        )}
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
