import { useTranslation } from "react-i18next";
import type { FlowActionNode } from "@/shared/types/flow";
import { ACTION_INPUTS, KNOWN_ACTIONS } from "../../../lib/known-actions";
import { KeyValueEditor } from "../KeyValueEditor";
import { TextField } from "../fields";
import { formatValue, parseValue } from "./ValueRows";
import { recordOrUndefined, type KindFormProps } from "./types";

/** The required inputs of an action as empty strings, keeping values already set under the same name. */
function seedInputs(uses: string, current: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const seeded: Record<string, unknown> = {};
  for (const input of ACTION_INPUTS[uses] ?? []) {
    if (input.required) seeded[input.name] = current?.[input.name] ?? "";
  }
  return recordOrUndefined(seeded);
}

export function ActionForm({ node, path, onChange }: KindFormProps<FlowActionNode>) {
  const { t } = useTranslation("flow");
  const write = (patch: Partial<FlowActionNode>) => onChange(path, patch);
  const options = KNOWN_ACTIONS.includes(node.uses) ? KNOWN_ACTIONS : [node.uses, ...KNOWN_ACTIONS];
  return (
    <div className="flow-attrs">
      <label className="flow-attrs__field">
        <span>{t("attrs.uses")}</span>
        <select aria-label={t("attrs.uses")} value={node.uses} onChange={(e) => write({ uses: e.target.value, with: seedInputs(e.target.value, node.with) })}>
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <div className="flow-attrs__field">
        <span>{t("attrs.with")}</span>
        <KeyValueEditor<unknown>
          entries={node.with ?? {}}
          addLabel={t("attrs.addRow")}
          makeEntry={() => ""}
          columns={[
            {
              id: "value",
              label: t("attrs.envValue"),
              render: (value, set) => (
                <TextField label={t("attrs.envValue")} value={formatValue(value)} onCommit={(text) => set(parseValue(text, undefined, value))} />
              ),
            },
          ]}
          onChange={(next) => write({ with: recordOrUndefined(next) })}
        />
      </div>
    </div>
  );
}
