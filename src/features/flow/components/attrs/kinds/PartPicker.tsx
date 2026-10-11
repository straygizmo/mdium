import { useTranslation } from "react-i18next";
import type { FlowSummary } from "@/shared/types/flow";
import { paramsFor, partLabel, relativeRef } from "../../../lib/part-ref";
import { signatureText } from "../../FlowPanel";
import { ValueRows, type ValueFieldSpec } from "./ValueRows";

/** Callee defaults, overridden by the current value of every key the callee still declares. */
function mergeParams(defaults: Record<string, unknown>, current: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) out[key] = current && key in current ? current[key] : value;
  return out;
}

interface PartPickerProps {
  label: string;
  /** Currently referenced part path (as written in the flow file). */
  value: string;
  parts: FlowSummary[];
  /** Project-relative path of the file being edited (decides how parts are referenced). */
  currentFile: string;
  params: Record<string, unknown> | undefined;
  /** Called with the new reference and the callee's default params. */
  onPick: (ref: string, params: Record<string, unknown>) => void;
  onParamsChange: (params: Record<string, unknown>) => void;
}

/** Part selector with the callee signature and one `params` row per callee parameter. */
export function PartPicker({ label, value, parts, currentFile, params, onPick, onParamsChange }: PartPickerProps) {
  const { t } = useTranslation("flow");
  const entries = parts.map((part) => ({ part, ref: relativeRef(currentFile, part.path) }));
  const selected = entries.find((e) => e.ref === value);
  const fields: ValueFieldSpec[] = selected
    ? Object.entries(selected.part.params).map(([name, def]) => ({
        name,
        type: def.type,
        required: def.required === true,
        description: def.description,
      }))
    : [];
  return (
    <div className="flow-attrs__field">
      <label className="flow-attrs__field">
        <span>{label}</span>
        <select
          aria-label={label}
          value={value}
          onChange={(e) => {
            const picked = entries.find((x) => x.ref === e.target.value);
            if (picked) onPick(picked.ref, mergeParams(paramsFor(picked.part), params));
          }}
        >
          {!selected && <option value={value}>{value === "" ? t("attrs.choosePart") : value}</option>}
          {entries.map(({ part, ref }) => (
            <option key={part.path} value={ref}>
              {partLabel(part)}
            </option>
          ))}
        </select>
      </label>
      {selected && <div className="flow-attrs__hint">{signatureText(selected.part, t)}</div>}
      {(selected || (params && Object.keys(params).length > 0)) && (
        <>
          <span>{t("attrs.params")}</span>
          <ValueRows fields={fields} values={params} onChange={onParamsChange} />
        </>
      )}
    </div>
  );
}
