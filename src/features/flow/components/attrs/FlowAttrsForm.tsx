import { useTranslation } from "react-i18next";
import type { FlowDef, FlowKind, FlowParamDef, FlowParamType } from "@/shared/types/flow";
import type { updateFlowAttrs } from "../../lib/editor-state";
import { NumberField, RetryFields, TextField, compact } from "./fields";
import { KeyValueEditor, type ColumnSpec } from "./KeyValueEditor";
import { StringListEditor } from "./StringListEditor";

export type FlowAttrsPatch = Parameters<typeof updateFlowAttrs>[1];

interface FlowAttrsFormProps {
  def: FlowDef;
  onChange: (patch: FlowAttrsPatch) => void;
  /** A part opens with its signature (params / outputs) first. */
  kind?: FlowKind | null;
}

const PARAM_TYPES: FlowParamType[] = ["string", "number", "bool", "path"];

/** An empty record deletes its key. */
function orUndefined<T>(record: Record<string, T>): Record<string, T> | undefined {
  return Object.keys(record).length === 0 ? undefined : record;
}

/** Parses a param default by the param's type; blank is `undefined`. */
function parseDefault(type: FlowParamType, text: string): unknown {
  if (text === "") return undefined;
  if (type === "number") {
    const n = Number(text);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === "bool") return text === "true";
  return text;
}

function displayDefault(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function StringCell({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  return <TextField label={label} value={value} onCommit={(next) => onChange(next ?? "")} />;
}

/** Flow-level attributes: name, params, defaults, limits, env and outputs. */
export function FlowAttrsForm({ def, onChange, kind = null }: FlowAttrsFormProps) {
  const { t } = useTranslation("flow");
  const defaults = def.defaults;
  const limits = def.limits;

  const paramColumns: ColumnSpec<FlowParamDef>[] = [
    {
      id: "type",
      label: t("attrs.paramType"),
      render: (p, set) => (
        <select aria-label={t("attrs.paramType")} value={p.type} onChange={(e) => set({ ...p, type: e.target.value as FlowParamType })}>
          {PARAM_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      ),
    },
    {
      id: "required",
      label: t("attrs.paramRequired"),
      render: (p, set) => (
        <label className="flow-attrs__check">
          <input type="checkbox" checked={p.required ?? false} onChange={(e) => set({ ...p, required: e.target.checked })} />
          <span>{t("attrs.paramRequired")}</span>
        </label>
      ),
    },
    {
      id: "default",
      label: t("attrs.paramDefault"),
      render: (p, set) => (
        <TextField
          label={t("attrs.paramDefault")}
          value={displayDefault(p.default) || undefined}
          onCommit={(text) => set({ ...p, default: parseDefault(p.type, text ?? "") })}
        />
      ),
    },
    {
      id: "description",
      label: t("attrs.description"),
      render: (p, set) => <TextField label={t("attrs.description")} value={p.description} onCommit={(description) => set({ ...p, description })} />,
    },
  ];

  const stringColumn = (label: string): ColumnSpec<string>[] => [
    { id: "value", label, render: (v, set) => <StringCell label={label} value={v} onChange={set} /> },
  ];

  const paramsSection = (
    <section className="flow-attrs__section">
      <h4>{t("attrs.params")}</h4>
      <KeyValueEditor<FlowParamDef>
        entries={def.params ?? {}}
        columns={paramColumns}
        addLabel={t("attrs.addRow")}
        makeEntry={() => ({ type: "string", required: false })}
        onChange={(params) => onChange({ params: orUndefined(params) })}
      />
    </section>
  );

  const outputsSection = (
    <section className="flow-attrs__section">
      <h4>{t("attrs.outputs")}</h4>
      <KeyValueEditor<string>
        entries={def.outputs ?? {}}
        columns={stringColumn(t("attrs.outputTemplate"))}
        addLabel={t("attrs.addRow")}
        makeEntry={() => ""}
        onChange={(outputs) => onChange({ outputs: orUndefined(outputs) })}
      />
    </section>
  );

  return (
    <div className="flow-attrs">
      {kind === "part" && (
        <section className="flow-attrs__section flow-attrs__signature">
          <h3 className="flow-attrs__title">{t("signature.title")}</h3>
          {paramsSection}
          {outputsSection}
        </section>
      )}
      <h3 className="flow-attrs__title">{t("attrs.flowTitle")}</h3>
      <TextField label={t("attrs.name")} value={def.name} onCommit={(name) => onChange({ name: name ?? "" })} />
      <TextField label={t("attrs.description")} value={def.description} multiline onCommit={(description) => onChange({ description })} />

      {kind !== "part" && paramsSection}

      <section className="flow-attrs__section">
        <h4>{t("attrs.defaults")}</h4>
        <TextField
          label={t("attrs.timeout")}
          value={defaults?.timeout}
          placeholder="30s"
          onCommit={(timeout) => onChange({ defaults: compact({ ...defaults, timeout }) })}
        />
        <RetryFields value={defaults?.retry} onChange={(retry) => onChange({ defaults: compact({ ...defaults, retry }) })} />
        <TextField
          label={t("attrs.workingDir")}
          value={defaults?.workingDir}
          onCommit={(workingDir) => onChange({ defaults: compact({ ...defaults, workingDir }) })}
        />
      </section>

      <section className="flow-attrs__section">
        <h4>{t("attrs.limits")}</h4>
        <NumberField
          label={t("attrs.maxConcurrentNodes")}
          value={limits?.maxConcurrentNodes}
          onCommit={(maxConcurrentNodes) => onChange({ limits: compact({ ...limits, maxConcurrentNodes }) })}
        />
        <NumberField label={t("attrs.costBudget")} value={limits?.budgetUsd} onCommit={(budgetUsd) => onChange({ limits: compact({ ...limits, budgetUsd }) })} />
        <TextField label={t("attrs.stopGrace")} value={limits?.stopGrace} onCommit={(stopGrace) => onChange({ limits: compact({ ...limits, stopGrace }) })} />
      </section>

      <section className="flow-attrs__section">
        <h4>{t("attrs.env")}</h4>
        <KeyValueEditor<string>
          entries={def.env ?? {}}
          columns={stringColumn(t("attrs.envValue"))}
          addLabel={t("attrs.addRow")}
          makeEntry={() => ""}
          onChange={(env) => onChange({ env: orUndefined(env) })}
        />
      </section>

      <section className="flow-attrs__section">
        <h4>{t("attrs.envPassthrough")}</h4>
        <StringListEditor
          items={def.envPassthrough ?? []}
          addLabel={t("attrs.addRow")}
          onChange={(items) => onChange({ envPassthrough: items.length > 0 ? items : undefined })}
        />
      </section>

      {kind !== "part" && outputsSection}
    </div>
  );
}
