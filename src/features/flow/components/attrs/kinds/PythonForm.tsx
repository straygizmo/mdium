import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowPythonNode, Manifest, StageDef } from "@/shared/types/flow";
import { flowApi, isFlowCommandError } from "../../../lib/flow-api";
import { initialValues, mergeValues } from "../../../lib/part-ref";
import { describeError } from "../../../lib/run-format";
import { ValueRows, type ValueFieldSpec } from "./ValueRows";
import type { KindFormProps } from "./types";

type RuntimeState =
  | { status: "loading" }
  | { status: "error"; code: string; message: string }
  | { status: "ready"; manifest: Manifest };

interface PythonFormProps extends KindFormProps<FlowPythonNode> {
  /** Project folder (the runtime worker is started there). */
  projectRoot: string;
}

/** `with` for a stage: the current value of a key when present, else its initial value (see `initialValues`). */
function withFor(stage: StageDef, current: Record<string, unknown> | undefined): Record<string, unknown> {
  return mergeValues(Object.keys(stage.inputs), initialValues(stage.inputs), current);
}

export function PythonForm({ node, path, project, projectRoot, onChange }: PythonFormProps) {
  const { t } = useTranslation("flow");
  const runtimeNames = Object.keys(project?.project?.runtimes ?? {});
  const sha256 = project?.sha256;
  // Manifests are cached per runtime for the lifetime of the form.
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeState>>({});
  // Late replies for a runtime the user already left are still cached; only unmounting drops them.
  const mounted = useRef(true);
  const runtime = node.runtime;
  const known = runtime !== "" && runtimeNames.includes(runtime);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sha256 || !known || runtimes[runtime]) return;
    setRuntimes((prev) => ({ ...prev, [runtime]: { status: "loading" } }));
    flowApi
      .runtimeDescribe(projectRoot, runtime, sha256)
      .then((manifest) => {
        if (mounted.current) setRuntimes((prev) => ({ ...prev, [runtime]: { status: "ready", manifest } }));
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        const state: RuntimeState = isFlowCommandError(err)
          ? { status: "error", code: err.code, message: err.message }
          : { status: "error", code: "FLOW_COMMAND_FAILED", message: String(err) };
        setRuntimes((prev) => ({ ...prev, [runtime]: state }));
      });
    // `runtimes` is read only to skip runtimes that are already cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, sha256, runtime, known]);

  const state = known ? (runtimes[runtime] ?? { status: "loading" }) : undefined;
  const stages = state?.status === "ready" ? state.manifest.stages : [];
  const stage = stages.find((s) => s.name === node.entry);
  const fields: ValueFieldSpec[] = stage
    ? Object.entries(stage.inputs).map(([name, input]) => ({ name, type: input.type, required: input.required, description: input.description }))
    : [];

  return (
    <div className="flow-attrs">
      {runtimeNames.length === 0 && <div className="flow-attrs__hint">{t("attrs.noRuntime")}</div>}
      <label className="flow-attrs__field">
        <span>{t("attrs.runtime")}</span>
        <select
          aria-label={t("attrs.runtime")}
          value={runtime}
          onChange={(e) => onChange(path, { runtime: e.target.value, entry: "", with: undefined })}
        >
          {!known && <option value={runtime}>{runtime}</option>}
          {runtimeNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {state?.status === "loading" && <div className="flow-attrs__hint">{t("attrs.loadingStages")}</div>}
      {state?.status === "error" && <div className="flow-attrs__error">{describeError(t, { code: state.code, message: state.message }).message}</div>}
      <label className="flow-attrs__field">
        <span>{t("attrs.entry")}</span>
        <select
          aria-label={t("attrs.entry")}
          value={node.entry}
          onChange={(e) => {
            const next = stages.find((s) => s.name === e.target.value);
            if (next) onChange(path, { entry: next.name, with: withFor(next, node.with) });
          }}
        >
          {!stage && <option value={node.entry}>{node.entry}</option>}
          {stages.map((s) => (
            <option key={s.name} value={s.name} title={s.description}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {(stage || (node.with && Object.keys(node.with).length > 0)) && (
        <div className="flow-attrs__field">
          <span>{t("attrs.inputs")}</span>
          <ValueRows fields={fields} values={node.with} onChange={(next) => onChange(path, { with: next })} />
        </div>
      )}
    </div>
  );
}
