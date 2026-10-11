import { useTranslation } from "react-i18next";
import type { FlowActionNode } from "@/shared/types/flow";
import { KeyValueEditor } from "../KeyValueEditor";
import { TextField } from "../fields";
import { formatValue, parseValue } from "./ValueRows";
import { recordOrUndefined, type KindFormProps } from "./types";

/** Built-in actions: the `KNOWN_ACTIONS` of flow-core plus the names the editor and project tooling use. */
export const KNOWN_ACTIONS = [
  "mdium/flow-run-latest",
  "mdium/metrics-compare",
  "mdium/project-setup",
  "mdium/screen-input",
  "mdium/git-worktree-create",
  "mdium/design-doc-commit",
  "mdium/issue-entry",
  "mdium/git-merge-local",
  "mdium/issue-close",
  "mdium/git-worktree-discard",
];

export function ActionForm({ node, path, onChange }: KindFormProps<FlowActionNode>) {
  const { t } = useTranslation("flow");
  const write = (patch: Partial<FlowActionNode>) => onChange(path, patch);
  const options = KNOWN_ACTIONS.includes(node.uses) ? KNOWN_ACTIONS : [node.uses, ...KNOWN_ACTIONS];
  return (
    <div className="flow-attrs">
      <label className="flow-attrs__field">
        <span>{t("attrs.uses")}</span>
        <select aria-label={t("attrs.uses")} value={node.uses} onChange={(e) => write({ uses: e.target.value })}>
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
