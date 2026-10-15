import { useTranslation } from "react-i18next";
import type { FlowCommandNode } from "@/shared/types/flow";
import { KeyValueEditor } from "../KeyValueEditor";
import { TextField } from "../fields";
import { recordOrUndefined, type KindFormProps } from "./types";

const PROTOCOLS: FlowCommandNode["protocol"][] = ["mdium-v1", "none"];

const toLines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line.trim() !== "");

/** Joins argv into one shell command; an argument containing whitespace is quoted so it stays one argument. */
export function joinArgv(argv: string[]): string {
  return argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** Parses comma-separated exit codes; returns `null` when an entry is not a number. */
function parseCodes(text: string): number[] | null {
  const parts = text.split(",").map((p) => p.trim()).filter((p) => p !== "");
  const codes = parts.map(Number);
  return codes.some((n) => Number.isNaN(n)) ? null : codes;
}

export function CommandForm({ node, path, onChange }: KindFormProps<FlowCommandNode>) {
  const { t } = useTranslation("flow");
  const write = (patch: Partial<FlowCommandNode>) => onChange(path, patch);
  const runText = Array.isArray(node.run) ? node.run.join("\n") : node.run;
  return (
    <div className="flow-attrs">
      <TextField
        label={node.shell ? t("attrs.runShell") : t("attrs.run")}
        multiline
        value={runText}
        onCommit={(text) => write({ run: node.shell ? (text ?? "") : toLines(text ?? "") })}
      />
      <label className="flow-attrs__check">
        <input
          type="checkbox"
          checked={node.shell}
          onChange={(e) => {
            const shell = e.target.checked;
            if (shell) write({ shell, run: Array.isArray(node.run) ? joinArgv(node.run) : node.run });
            else write({ shell, run: Array.isArray(node.run) ? node.run : toLines(node.run) });
          }}
        />
        <span>{t("attrs.shell")}</span>
      </label>
      <TextField label={t("attrs.workingDir")} value={node.workingDir} onCommit={(workingDir) => write({ workingDir })} />
      <div className="flow-attrs__field">
        <span>{t("attrs.env")}</span>
        <KeyValueEditor<string>
          entries={node.env ?? {}}
          addLabel={t("attrs.addRow")}
          makeEntry={() => ""}
          columns={[
            {
              id: "value",
              label: t("attrs.envValue"),
              render: (value, set) => <TextField label={t("attrs.envValue")} value={value} onCommit={(next) => set(next ?? "")} />,
            },
          ]}
          onChange={(env) => write({ env: recordOrUndefined(env) })}
        />
      </div>
      <TextField
        label={t("attrs.successCodes")}
        value={node.successCodes?.join(", ")}
        placeholder="0"
        validate={(text) => parseCodes(text) !== null}
        onCommit={(text) => write({ successCodes: text === undefined ? undefined : (parseCodes(text) ?? undefined) })}
      />
      <label className="flow-attrs__field">
        <span>{t("attrs.protocol")}</span>
        <select
          aria-label={t("attrs.protocol")}
          value={node.protocol}
          onChange={(e) => write({ protocol: e.target.value as FlowCommandNode["protocol"] })}
        >
          {PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flow-attrs__check">
        <input type="checkbox" checked={node.detach === true} onChange={(e) => write({ detach: e.target.checked ? true : undefined })} />
        <span>{t("attrs.detach")}</span>
      </label>
    </div>
  );
}
