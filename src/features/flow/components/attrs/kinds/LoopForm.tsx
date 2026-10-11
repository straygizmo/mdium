import { useTranslation } from "react-i18next";
import type { FlowLoopNode } from "@/shared/types/flow";
import { ConditionEditor, newComparison } from "../ConditionEditor";
import { NumberField, TextField } from "../fields";
import { PartPicker } from "./PartPicker";
import type { KindFormProps } from "./types";

const MODES: FlowLoopNode["mode"][] = ["foreach", "while"];
const FAILURE_MODES: NonNullable<FlowLoopNode["onItemFailure"]>[] = ["stop", "continue"];

/** Shows `items` as text: a string as-is, a list as JSON. */
function itemsText(items: FlowLoopNode["items"]): string | undefined {
  if (items === undefined) return undefined;
  return typeof items === "string" ? items : JSON.stringify(items);
}

/** A text that starts with `[` and parses to an array becomes a list; anything else stays a string. */
function parseItems(text: string | undefined): FlowLoopNode["items"] {
  if (text === undefined) return undefined;
  if (text.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed as unknown[];
    } catch {
      // Not valid JSON: keep it as a template string.
    }
  }
  return text;
}

export function LoopForm({ node, path, parts, currentFile, onChange }: KindFormProps<FlowLoopNode>) {
  const { t } = useTranslation("flow");
  const write = (patch: Partial<FlowLoopNode>) => onChange(path, patch);
  // `until` only applies to `while` loops.
  const onModeChange = (mode: FlowLoopNode["mode"]) => write(mode === "while" ? { mode } : { mode, until: undefined });
  return (
    <div className="flow-attrs">
      <label className="flow-attrs__field">
        <span>{t("attrs.mode")}</span>
        <select aria-label={t("attrs.mode")} value={node.mode} onChange={(e) => onModeChange(e.target.value as FlowLoopNode["mode"])}>
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`attrs.modeValue.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      <TextField label={t("attrs.items")} value={itemsText(node.items)} onCommit={(text) => write({ items: parseItems(text) })} />
      {node.mode === "while" && (
        <div className="flow-attrs__field">
          <label className="flow-attrs__check">
            <input type="checkbox" checked={node.until !== undefined} onChange={(e) => write({ until: e.target.checked ? newComparison() : undefined })} />
            <span>{t("attrs.condition.enable")}</span>
          </label>
          <span>{t("attrs.until")}</span>
          {node.until !== undefined && <ConditionEditor value={node.until} onChange={(until) => write({ until })} />}
        </div>
      )}
      <NumberField label={t("attrs.maxIterations")} value={node.maxIterations} onCommit={(maxIterations) => write({ maxIterations })} />
      <NumberField label={t("attrs.parallelism")} value={node.parallelism} onCommit={(parallelism) => write({ parallelism })} />
      <TextField label={t("attrs.as")} value={node.as} placeholder="item" onCommit={(as) => write({ as })} />
      <label className="flow-attrs__field">
        <span>{t("attrs.onItemFailure")}</span>
        <select
          aria-label={t("attrs.onItemFailure")}
          value={node.onItemFailure ?? "stop"}
          onChange={(e) => write({ onItemFailure: e.target.value as NonNullable<FlowLoopNode["onItemFailure"]> })}
        >
          {FAILURE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`attrs.onItemFailureValue.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      {typeof node.body === "string" ? (
        <PartPicker
          label={t("attrs.body")}
          value={node.body}
          parts={parts}
          currentFile={currentFile}
          params={node.params}
          onPick={(body, params) => write({ body, params })}
          onParamsChange={(params) => write({ params })}
        />
      ) : (
        <div className="flow-attrs__hint">{t("attrs.inlineBodyHint")}</div>
      )}
    </div>
  );
}
