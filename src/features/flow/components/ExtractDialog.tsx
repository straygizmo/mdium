import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import type { FlowDef, FlowIssue } from "@/shared/types/flow";
import { extractSubflow } from "../lib/extract-subflow";
import { FlowIssueList } from "./FlowIssueList";

/** Project-relative path of the part file an extraction named `name` creates. */
export function extractedPartPath(name: string): string {
  return `.mdium/flows/lib/${name}.flow.yaml`;
}

/** Default part name: `part-<n>` for the smallest positive n without a `lib/part-<n>.flow.yaml`. */
export function defaultPartName(existingParts: string[]): string {
  const taken = new Set(existingParts.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  let n = 1;
  while (taken.has(extractedPartPath(`part-${n}`))) n++;
  return `part-${n}`;
}

interface ExtractDialogProps {
  def: FlowDef;
  selectedPaths: string[];
  currentFile: string;
  /** Project-relative paths of the existing parts. */
  existingParts: string[];
  /** Validation errors of the last attempt; shown under `extract.failedValidation`. */
  failure?: FlowIssue[];
  busy?: boolean;
  onConfirm(name: string): void;
  onClose(): void;
}

/** Previews the signature an extraction would infer and asks for the new part's name. */
export function ExtractDialog({ def, selectedPaths, currentFile, existingParts, failure, busy, onConfirm, onClose }: ExtractDialogProps) {
  const { t } = useTranslation("flow");
  const [name, setName] = useState(() => defaultPartName(existingParts));

  const outcome = useMemo(() => extractSubflow(def, selectedPaths, name, currentFile), [def, selectedPaths, name, currentFile]);
  const exists = existingParts.some((p) => p.replace(/\\/g, "/").toLowerCase() === extractedPartPath(name).toLowerCase());
  const canConfirm = outcome.ok && !exists && !busy;
  const list = (items: string[]) => (items.length > 0 ? items.join(", ") : t("extract.none"));

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canConfirm) onConfirm(name);
  };

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog" labelledBy="flow-extract-title" onClose={onClose}>
      <form className="flow-dialog__section" onSubmit={submit}>
        <h2 id="flow-extract-title" className="flow-dialog__title">
          {t("extract.title")}
        </h2>
        <label className="flow-dialog__field">
          <span className="flow-dialog__label">{t("extract.name")}</span>
          <input className="flow-dialog__input" aria-label={t("extract.name")} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {exists && (
          <div className="flow-dialog__error" role="alert">
            {t("extract.exists")}
          </div>
        )}
        {outcome.ok ? (
          <div className="flow-dialog__field">
            <span className="flow-dialog__label">{t("extract.preview")}</span>
            <div className="flow-dialog__muted">
              {t("extract.params")}: {list(outcome.signature.params)}
            </div>
            <div className="flow-dialog__muted">
              {t("extract.outputs")}: {list(outcome.signature.outputs)}
            </div>
          </div>
        ) : (
          <div className="flow-dialog__error" role="alert">
            {t(`extract.reason.${outcome.reason}`)}
          </div>
        )}
        {failure && failure.length > 0 && (
          <div className="flow-dialog__field">
            <div className="flow-dialog__error" role="alert">
              {t("extract.failedValidation")}
            </div>
            <FlowIssueList errors={failure} warnings={[]} />
          </div>
        )}
        <div className="flow-dialog__footer">
          <button type="button" className="flow-dialog__button" onClick={onClose}>
            {t("editor.cancel")}
          </button>
          <button type="submit" className="flow-dialog__button flow-dialog__button--primary" disabled={!canConfirm}>
            {t("extract.confirm")}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
