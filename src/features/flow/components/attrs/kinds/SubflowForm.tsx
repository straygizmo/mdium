import { useTranslation } from "react-i18next";
import type { FlowSubflowNode } from "@/shared/types/flow";
import { TextField } from "../fields";
import { PartPicker } from "./PartPicker";
import type { KindFormProps } from "./types";

export function SubflowForm({ node, path, parts, currentFile, onChange }: KindFormProps<FlowSubflowNode>) {
  const { t } = useTranslation("flow");
  return (
    <div className="flow-attrs">
      <PartPicker
        label={t("attrs.flow")}
        value={node.flow}
        parts={parts}
        currentFile={currentFile}
        params={node.params}
        onPick={(flow, params) => onChange(path, { flow, params })}
        onParamsChange={(params) => onChange(path, { params })}
      />
      <TextField label={t("attrs.projectRoot")} value={node.projectRoot} onCommit={(projectRoot) => onChange(path, { projectRoot })} />
      <div className="flow-attrs__hint">{t("attrs.projectRootHint")}</div>
    </div>
  );
}
