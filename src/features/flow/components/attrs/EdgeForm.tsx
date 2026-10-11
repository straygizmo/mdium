import { useTranslation } from "react-i18next";
import type { FlowEdge } from "@/shared/types/flow";
import { NumberField, TextField } from "./fields";

interface EdgeFormProps {
  edge: FlowEdge;
  path: string;
  /** Output ports of the source node. */
  ports: string[];
  onChange: (path: string, patch: Partial<FlowEdge>) => void;
  onDelete: (path: string) => void;
}

/** Attributes of one edge. */
export function EdgeForm({ edge, path, ports, onChange, onDelete }: EdgeFormProps) {
  const { t } = useTranslation("flow");
  const port = edge.port ?? "success";
  // The current port is always listed (even an implicit `success` the source lacks), so every
  // real option, the first included, is a change the select reports.
  const options = ports.includes(port) ? ports : [...ports, port];
  return (
    <div className="flow-attrs">
      <TextField label={t("attrs.from")} value={edge.from} readOnly onCommit={() => undefined} />
      <TextField label={t("attrs.to")} value={edge.to} readOnly onCommit={() => undefined} />
      <label className="flow-attrs__field">
        <span>{t("attrs.port")}</span>
        <select aria-label={t("attrs.port")} value={port} onChange={(e) => onChange(path, { port: e.target.value })}>
          {options.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <NumberField label={t("attrs.maxTraversals")} value={edge.maxTraversals} onCommit={(maxTraversals) => onChange(path, { maxTraversals })} />
      <button type="button" onClick={() => onDelete(path)}>
        {t("attrs.deleteEdge")}
      </button>
    </div>
  );
}
