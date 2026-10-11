import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowCostSpec, FlowIssue, FlowNode } from "@/shared/types/flow";
import { isNodeId } from "../../lib/flow-ports";
import { describeReason } from "../../lib/run-format";
import { ConditionEditor, newComparison } from "./ConditionEditor";
import { NumberField, RetryFields, TextField, compact } from "./fields";

interface NodeCommonFormProps {
  node: FlowNode;
  path: string;
  /** Validation issues of the whole flow; the ones under this node are listed. */
  issues: FlowIssue[];
  /** Every node id in the flow (inline bodies included); a rename to one of them is vetoed. */
  usedIds: ReadonlySet<string>;
  onChange: (path: string, patch: Partial<FlowNode>) => void;
  onRename: (path: string, id: string) => void;
}

/** True when the issue points at the node itself (not at a node nested in its inline body). */
function belongsTo(issue: FlowIssue, path: string): boolean {
  if (issue.path === path) return true;
  if (!issue.path.startsWith(`${path}.`)) return false;
  return !issue.path.slice(path.length + 1).startsWith("body.nodes");
}

/** Attributes shared by every node kind. */
export function NodeCommonForm({ node, path, issues, usedIds, onChange, onRename }: NodeCommonFormProps) {
  const { t } = useTranslation("flow");
  const [idError, setIdError] = useState<"invalidId" | "idTaken" | null>(null);
  const own = issues.filter((i) => belongsTo(i, path));
  const write = (patch: Partial<FlowNode>) => onChange(path, patch);
  const writeCost = (patch: Partial<FlowCostSpec>) => write({ cost: compact({ estimateUsd: node.cost?.estimateUsd, budgetUsd: node.cost?.budgetUsd, ...patch }) });
  return (
    <div className="flow-attrs">
      <TextField
        label={t("attrs.id")}
        value={node.id}
        validate={(text) => {
          const error = !isNodeId(text) ? "invalidId" : text !== node.id && usedIds.has(text) ? "idTaken" : null;
          setIdError(error);
          return error === null;
        }}
        onCommit={(id) => id !== undefined && onRename(path, id)}
      />
      {idError === "invalidId" && <div className="flow-attrs__error">{t("attrs.invalidId")}</div>}
      {idError === "idTaken" && <div className="flow-attrs__error">{t("attrs.idTaken")}</div>}
      <TextField label={t("attrs.name")} value={node.name} onCommit={(name) => write({ name })} />
      <TextField label={t("attrs.description")} value={node.description} multiline onCommit={(description) => write({ description })} />
      <TextField label={t("attrs.timeout")} value={node.timeout} placeholder="30s" onCommit={(timeout) => write({ timeout })} />
      <RetryFields value={node.retry} onChange={(retry) => write({ retry })} />
      <div className="flow-attrs__row">
        <NumberField label={t("attrs.costEstimate")} value={node.cost?.estimateUsd} onCommit={(estimateUsd) => writeCost({ estimateUsd })} />
        <NumberField label={t("attrs.costBudget")} value={node.cost?.budgetUsd} onCommit={(budgetUsd) => writeCost({ budgetUsd })} />
      </div>
      <div className="flow-attrs__field">
        <label className="flow-attrs__check">
          <input
            type="checkbox"
            checked={node.when !== undefined}
            onChange={(e) => write({ when: e.target.checked ? newComparison() : undefined })}
          />
          <span>{t("attrs.condition.enable")}</span>
        </label>
        <span>{t("attrs.when")}</span>
        {node.when !== undefined && <ConditionEditor value={node.when} onChange={(when) => write({ when })} />}
      </div>
      <TextField label={t("attrs.concurrencyKey")} value={node.concurrencyKey} onCommit={(concurrencyKey) => write({ concurrencyKey })} />
      {own.length > 0 && (
        <ul className="flow-attrs__issues">
          {own.map((issue, i) => (
            <li key={i} className="flow-attrs__error">
              {describeReason(t, { code: issue.code, params: issue.params })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
