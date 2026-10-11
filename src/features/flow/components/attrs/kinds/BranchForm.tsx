import { useTranslation } from "react-i18next";
import type { FlowBranchNode } from "@/shared/types/flow";
import { ConditionEditor, newComparison } from "../ConditionEditor";
import { TextField } from "../fields";
import type { KindFormProps } from "./types";

export function BranchForm({ node, path, onChange }: KindFormProps<FlowBranchNode>) {
  const { t } = useTranslation("flow");
  const write = (patch: Partial<FlowBranchNode>) => onChange(path, patch);
  const cases = node.cases;
  const replace = (i: number, next: FlowBranchNode["cases"][number]) => write({ cases: cases.map((c, j) => (j === i ? next : c)) });
  return (
    <div className="flow-attrs">
      <div className="flow-attrs__field">
        <span>{t("attrs.cases")}</span>
        <div className="flow-attrs__list">
          {cases.map((c, i) => (
            <div key={i} className="flow-attrs__case">
              <ConditionEditor value={c.when} onChange={(when) => replace(i, { ...c, when })} />
              <TextField label={t("attrs.casePort")} value={c.port} onCommit={(port) => replace(i, { ...c, port: port ?? "" })} />
              <button type="button" onClick={() => write({ cases: cases.filter((_, j) => j !== i) })}>
                {t("attrs.remove")}
              </button>
            </div>
          ))}
          <button type="button" onClick={() => write({ cases: [...cases, { when: newComparison(), port: "" }] })}>
            {t("attrs.addCase")}
          </button>
        </div>
      </div>
      <TextField label={t("attrs.defaultPort")} value={node.default} onCommit={(port) => write({ default: port })} />
    </div>
  );
}
