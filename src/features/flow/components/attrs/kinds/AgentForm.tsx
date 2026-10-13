import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowAgentNode, FlowAgentProvider } from "@/shared/types/flow";
import { TextField } from "../fields";
import type { KindFormProps } from "./types";

const PROVIDERS: FlowAgentProvider[] = ["claude", "codex", "copilot", "opencode"];
const PERMISSIONS: FlowAgentNode["permission"][] = ["read-only", "full-access"];
const CONTRACTS: FlowAgentNode["outputContract"][] = ["outcome", "free"];

type PromptMode = "inline" | "file";

export function AgentForm({ node, path, onChange }: KindFormProps<FlowAgentNode>) {
  const { t } = useTranslation("flow");
  const [mode, setMode] = useState<PromptMode>(node.promptRef !== undefined ? "file" : "inline");
  const write = (patch: Partial<FlowAgentNode>) => onChange(path, patch);
  return (
    <div className="flow-attrs">
      <label className="flow-attrs__field">
        <span>{t("attrs.provider")}</span>
        <select aria-label={t("attrs.provider")} value={node.provider} onChange={(e) => write({ provider: e.target.value as FlowAgentProvider })}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          {/* A templated provider (`${{ params.provider }}`) stays selectable as written. */}
          {!(PROVIDERS as string[]).includes(node.provider) && <option value={node.provider}>{node.provider}</option>}
        </select>
      </label>
      <TextField label={t("attrs.model")} value={node.model} onCommit={(model) => write({ model })} />
      <fieldset className="flow-attrs__field">
        <legend>{t("attrs.promptSource")}</legend>
        {(["inline", "file"] as const).map((m) => (
          <label key={m} className="flow-attrs__check">
            <input type="radio" name={`${path}-prompt-source`} checked={mode === m} onChange={() => setMode(m)} />
            <span>{t(`attrs.promptSourceValue.${m}`)}</span>
          </label>
        ))}
      </fieldset>
      {mode === "inline" ? (
        <TextField label={t("attrs.prompt")} multiline value={node.prompt} onCommit={(prompt) => write({ prompt, promptRef: undefined })} />
      ) : (
        <TextField label={t("attrs.promptRef")} value={node.promptRef} onCommit={(promptRef) => write({ promptRef, prompt: undefined })} />
      )}
      <label className="flow-attrs__field">
        <span>{t("attrs.permission")}</span>
        <select
          aria-label={t("attrs.permission")}
          value={node.permission}
          onChange={(e) => write({ permission: e.target.value as FlowAgentNode["permission"] })}
        >
          {PERMISSIONS.map((p) => (
            <option key={p} value={p}>
              {t(`attrs.permissionValue.${p}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flow-attrs__field">
        <span>{t("attrs.outputContract")}</span>
        <select
          aria-label={t("attrs.outputContract")}
          value={node.outputContract}
          onChange={(e) => write({ outputContract: e.target.value as FlowAgentNode["outputContract"] })}
        >
          {CONTRACTS.map((c) => (
            <option key={c} value={c}>
              {t(`attrs.outputContractValue.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <TextField label={t("attrs.workingDir")} value={node.workingDir} onCommit={(workingDir) => write({ workingDir })} />
    </div>
  );
}
