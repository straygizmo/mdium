import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowDef, FlowNode, FlowNodeKind, FlowSummary, Manifest, ProjectLoadResult } from "@/shared/types/flow";
import { flowApi, isFlowCommandError } from "../lib/flow-api";
import { nextNodeId } from "../lib/flow-ports";
import { defaultsFor } from "../lib/editor-state";
import { describeError } from "../lib/run-format";
import { signatureText } from "./FlowPanel";
import "./Flow.css";

const PLAIN_KINDS: FlowNodeKind[] = ["command", "approval", "branch", "agent", "action"];
const PART_KINDS: FlowNodeKind[] = ["loop", "subflow"];

type RuntimeState =
  | { status: "loading" }
  | { status: "error"; code: string; message: string }
  | { status: "ready"; manifest: Manifest };

interface NodePaletteProps {
  projectRoot: string;
  /** Project-relative path of the file being edited (decides how parts are referenced). */
  currentFile: string;
  def: FlowDef;
  parts: FlowSummary[];
  project: ProjectLoadResult | null;
  onAdd: (node: FlowNode) => void;
  onClose: () => void;
}

function dirOf(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").slice(0, -1);
}

/** Path of `target` relative to the directory of `from` (both project-relative, forward slashes). */
export function relativeRef(from: string, target: string): string {
  const base = dirOf(from);
  const dest = target.replace(/\\/g, "/").split("/");
  const file = dest.pop() ?? "";
  let i = 0;
  while (i < base.length && i < dest.length && base[i] === dest[i]) i++;
  return [...base.slice(i).map(() => ".."), ...dest.slice(i), file].join("/");
}

function partLabel(part: FlowSummary): string {
  return part.path.replace(/\\/g, "/").split("/").pop()?.replace(/\.flow\.ya?ml$/, "") ?? part.path;
}

/** One key per callee param: its default when declared, otherwise an empty string. */
function paramsFor(part: FlowSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(part.params)) out[name] = def.default !== undefined ? def.default : "";
  return out;
}

/** Popover listing the node kinds, python stages and (for loop / sub-flow) the callable parts. */
export function NodePalette({ projectRoot, currentFile, def, parts, project, onAdd, onClose }: NodePaletteProps) {
  const { t } = useTranslation("flow");
  const [picking, setPicking] = useState<FlowNodeKind | null>(null);
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeState>>({});

  const runtimeNames = Object.keys(project?.project?.runtimes ?? {});
  const sha256 = project?.sha256;
  const runtimeKey = runtimeNames.join("\n");

  useEffect(() => {
    if (!sha256 || runtimeNames.length === 0) return;
    let cancelled = false;
    setRuntimes(Object.fromEntries(runtimeNames.map((name) => [name, { status: "loading" } as RuntimeState])));
    for (const name of runtimeNames) {
      flowApi
        .runtimeDescribe(projectRoot, name, sha256)
        .then((manifest) => {
          if (!cancelled) setRuntimes((prev) => ({ ...prev, [name]: { status: "ready", manifest } }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const state: RuntimeState = isFlowCommandError(err)
            ? { status: "error", code: err.code, message: err.message }
            : { status: "error", code: "FLOW_COMMAND_FAILED", message: String(err) };
          setRuntimes((prev) => ({ ...prev, [name]: state }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, sha256, runtimeKey]);

  const add = (kind: FlowNodeKind, extra: Record<string, unknown> = {}, base?: string) => {
    onAdd({ id: nextNodeId(def, kind, base), ...defaultsFor(kind), ...extra } as FlowNode);
    onClose();
  };

  const addPart = (kind: FlowNodeKind, part: FlowSummary) => {
    const ref = relativeRef(currentFile, part.path);
    add(kind, kind === "loop" ? { body: ref, params: paramsFor(part) } : { flow: ref, params: paramsFor(part) });
  };

  const addStage = (runtime: string, manifest: Manifest, stageName: string) => {
    const stage = manifest.stages.find((s) => s.name === stageName);
    if (!stage) return;
    const withInputs: Record<string, unknown> = {};
    for (const [key, input] of Object.entries(stage.inputs)) withInputs[key] = input.default !== undefined ? input.default : "";
    add("python", { runtime, entry: stage.name, with: withInputs }, stage.name);
  };

  return (
    <div className="flow-palette" role="dialog" aria-label={t("palette.title")}>
      <div className="flow-palette__title">{t("palette.title")}</div>
      <div className="flow-palette__group">
        {PLAIN_KINDS.map((kind) => (
          <button key={kind} type="button" className="flow-palette__item" onClick={() => add(kind)}>
            {t(`kind.${kind}`)}
          </button>
        ))}
        {PART_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className={`flow-palette__item${picking === kind ? " flow-palette__item--active" : ""}`}
            onClick={() => setPicking(picking === kind ? null : kind)}
          >
            {t(`kind.${kind}`)}
          </button>
        ))}
      </div>
      {picking && (
        <div className="flow-palette__group">
          <div className="flow-palette__label">{t("palette.pickPart")}</div>
          {parts.length === 0 && <div className="flow-palette__notice">{t("palette.noParts")}</div>}
          {parts.map((part) => (
            <button key={part.path} type="button" className="flow-palette__item" onClick={() => addPart(picking, part)}>
              <span>{partLabel(part)}</span> <span className="flow-palette__signature">{signatureText(part, t)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flow-palette__group">
        <div className="flow-palette__label">{t("palette.pythonStages")}</div>
        {runtimeNames.length === 0 && <div className="flow-palette__notice">{t("palette.noRuntime")}</div>}
        {runtimeNames.map((name) => {
          const state = runtimes[name] ?? { status: "loading" };
          if (state.status === "loading") {
            return (
              <div key={name} className="flow-palette__notice">
                {name}: {t("palette.loading")}
              </div>
            );
          }
          if (state.status === "error") {
            return (
              <div key={name} className="flow-palette__error">
                {name}: {describeError(t, { code: state.code, message: state.message }).message}
              </div>
            );
          }
          return state.manifest.stages.map((stage) => (
            <button
              key={`${name}/${stage.name}`}
              type="button"
              className="flow-palette__item"
              title={stage.description}
              onClick={() => addStage(name, state.manifest, stage.name)}
            >
              {stage.name}
            </button>
          ));
        })}
      </div>
    </div>
  );
}
