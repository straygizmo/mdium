import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import type { FlowDef, FlowEdge, FlowNode, FlowSummary, ProjectLoadResult } from "@/shared/types/flow";
import { flowApi } from "../lib/flow-api";
import { buildFlowGraph } from "../lib/flow-graph";
import { layoutFlowGraph, savedPositions, type FlowLayout } from "../lib/flow-layout";
import {
  addEdge,
  addNode,
  moveNode,
  nodeAt,
  removeEdge,
  removeNode,
  renameNode,
  updateEdge,
  updateFlowAttrs,
  updateNode,
} from "../lib/editor-state";
import { portsOf } from "../lib/flow-ports";
import { useFlowViewStore } from "../flow-store";
import { useFlowEditorStore, type Selection } from "../editor-store";
import { FlowCanvas, type ConnectRequest } from "./FlowCanvas";
import { FlowIssueList } from "./FlowIssueList";
import { FlowToolbar } from "./FlowToolbar";
import { FlowYamlPane, parseErrorMarkers } from "./FlowYamlPane";
import { NodePalette } from "./NodePalette";
import { PortPopover } from "./PortPopover";
import { RunPanel } from "./RunPanel";
import { SaveWarningDialog } from "./SaveWarningDialog";
import { ExternalChangeNotice } from "./ExternalChangeNotice";
import { AttributePanel } from "./attrs/AttributePanel";
import type { FlowAttrsPatch } from "./attrs/FlowAttrsForm";
import "./Flow.css";

/** Where the port popover opens when the canvas reported no drop point. */
const DEFAULT_ANCHOR = { x: 24, y: 24 };

/** Folder part of a project-relative path (`""` for a top-level file). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Absolute folder to watch for changes of the file at `path`. */
export function watchedFolder(projectRoot: string, path: string): string {
  const dir = dirname(path);
  return dir ? `${projectRoot.replace(/[\\/]+$/, "")}/${dir}` : projectRoot;
}

/** The scope (`""` or the owning loop's node path) of the node at `nodePath`. */
function scopeOf(nodePath: string): string {
  const i = nodePath.lastIndexOf(".body.");
  return i < 0 ? "" : nodePath.slice(0, i);
}

/** Graph path of the edge `from → to (port)` in `scope`, or `null` when absent. */
function edgePathOf(def: FlowDef, scope: string, edge: FlowEdge): string | null {
  let edges: FlowEdge[] | undefined = def.edges;
  if (scope) {
    const owner = nodeAt(def, scope);
    edges = owner && owner.kind === "loop" && typeof owner.body !== "string" ? owner.body.edges : undefined;
  }
  const index = (edges ?? []).findIndex((e) => e.from === edge.from && e.to === edge.to && e.port === edge.port);
  if (index < 0) return null;
  return scope ? `${scope}.body.edges[${index}]` : `edges[${index}]`;
}

interface PendingConnect {
  scope: string;
  from: string;
  to: string;
  ports: string[];
  anchor: { x: number; y: number };
  fromBackHandle: boolean;
}

interface PendingConfirm {
  message: string;
  resolve(ok: boolean): void;
}

const editor = () => useFlowEditorStore.getState();

/** Main area of the Flows view: the selected flow's editor (canvas, YAML, attributes, runs). */
export function FlowWorkspace() {
  const { t } = useTranslation("flow");
  const folder = useTabStore((s) => s.activeFolderPath);
  const path = useFlowViewStore((s) => (folder ? s.selected[folder] : undefined));

  const storePath = useFlowEditorStore((s) => s.path);
  const storeRoot = useFlowEditorStore((s) => s.projectRoot);
  const text = useFlowEditorStore((s) => s.text);
  const def = useFlowEditorStore((s) => s.def);
  const kind = useFlowEditorStore((s) => s.kind);
  const format = useFlowEditorStore((s) => s.format);
  const errors = useFlowEditorStore((s) => s.errors);
  const warnings = useFlowEditorStore((s) => s.warnings);
  const dirty = useFlowEditorStore((s) => s.dirty);
  const validating = useFlowEditorStore((s) => s.validating);
  const selection = useFlowEditorStore((s) => s.selection);
  const externalChange = useFlowEditorStore((s) => s.externalChange);
  const loadError = useFlowEditorStore((s) => s.loadError);
  const saveError = useFlowEditorStore((s) => s.saveError);
  const setText = useFlowEditorStore((s) => s.setText);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [layout, setLayout] = useState<FlowLayout | null>(null);
  const [layoutFailed, setLayoutFailed] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [connect, setConnect] = useState<PendingConnect | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [parts, setParts] = useState<FlowSummary[]>([]);
  const [project, setProject] = useState<ProjectLoadResult | null>(null);
  const savingRef = useRef(false);
  const confirmRef = useRef<PendingConfirm | null>(null);

  // The store holds the file this workspace shows (it may already hold it, e.g. a flow just created).
  const current = !!folder && !!path && storeRoot === folder && storePath === path;
  const readOnly = loadError !== null;
  const loading = current && kind === null && loadError === null && def === null;

  useEffect(() => {
    setCollapsed(new Set());
    setConnect(null);
    setJustSaved(false);
    if (!folder || !path) return;
    const s = editor();
    if (s.projectRoot !== folder || s.path !== path) void s.open(folder, path);
    return () => {
      const now = editor();
      if (now.projectRoot === folder && now.path === path) now.close();
    };
  }, [folder, path]);

  // Parts (for the palette and the sub-flow / loop forms) and the project manifest.
  useEffect(() => {
    if (!folder || !path) return;
    let cancelled = false;
    flowApi.list(folder).then(
      (flows) => !cancelled && setParts(flows.filter((f) => f.kind === "part" && f.path !== path)),
      () => !cancelled && setParts([]),
    );
    flowApi.projectLoad(folder).then(
      (loaded) => !cancelled && setProject(loaded),
      () => !cancelled && setProject(null),
    );
    return () => {
      cancelled = true;
    };
  }, [folder, path]);

  // External changes: compare the hash on disk with the one the editor holds.
  useEffect(() => {
    if (!folder || !path) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const onFolderChanged = async () => {
      const before = editor();
      if (before.projectRoot !== folder || before.path !== path) return;
      let sha256: string;
      try {
        sha256 = (await flowApi.load(folder, path)).sha256;
      } catch {
        return;
      }
      const now = editor();
      if (cancelled || now.projectRoot !== folder || now.path !== path || sha256 === now.savedSha256) return;
      if (now.dirty) now.markExternalChange();
      else await now.reload();
    };
    flowApi.watchFolder(watchedFolder(folder, path), () => void onFolderChanged()).then(
      (unwatch) => {
        if (cancelled) unwatch();
        else stop = unwatch;
      },
      () => {},
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [folder, path]);

  const issues = useMemo(() => ({ errors, warnings }), [errors, warnings]);
  const graph = useMemo(() => (current && def ? buildFlowGraph(def, collapsed, issues) : null), [current, def, collapsed, issues]);

  useEffect(() => {
    let cancelled = false;
    setLayoutFailed(false);
    if (!graph || !def) {
      setLayout(null);
      return;
    }
    // Keep the previous layout on screen until the new one is ready (no flicker while editing).
    layoutFlowGraph(graph, savedPositions(def.ui)).then(
      (next) => !cancelled && setLayout(next),
      () => !cancelled && setLayoutFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [graph, def]);

  // A pending confirmation resolves as "cancel" when the workspace goes away.
  useEffect(() => () => confirmRef.current?.resolve(false), []);

  const ask = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        const pending: PendingConfirm = {
          message,
          resolve: (ok) => {
            if (confirmRef.current === pending) confirmRef.current = null;
            setConfirm(null);
            resolve(ok);
          },
        };
        confirmRef.current = pending;
        setConfirm(pending);
      }),
    [],
  );

  const runSave = useCallback(async () => {
    if (savingRef.current || !current || editor().loadError) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await editor().validateNow();
      if (editor().errors.length > 0 && !(await ask(t("editor.saveWithErrors")))) return;
      if (editor().commentWarningPending) {
        if (!(await ask(t("editor.commentLoss")))) return;
        useFlowEditorStore.setState({ commentWarningPending: false });
      }
      const outcome = await editor().save({});
      if (outcome === "saved") setJustSaved(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [current, ask, t]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void runSave();
    }
  };

  const onReloadOutside = async () => {
    setNoticeBusy(true);
    try {
      await editor().reload();
    } finally {
      setNoticeBusy(false);
    }
  };

  const onOverwrite = async () => {
    setNoticeBusy(true);
    try {
      const outcome = await editor().save({ overwrite: true });
      if (outcome === "saved") setJustSaved(true);
    } finally {
      setNoticeBusy(false);
    }
  };

  const edit = useCallback((fn: (d: FlowDef) => FlowDef) => {
    setJustSaved(false);
    editor().applyEdit(fn);
  }, []);

  const onToggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onSelect = useCallback((sel: Selection) => editor().select(sel), []);
  const onMoveNode = useCallback(
    (nodeId: string, position: { x: number; y: number }) => edit((d) => moveNode(d, nodeId, position)),
    [edit],
  );

  const onConnect = useCallback((req: ConnectRequest) => {
    const d = editor().def;
    if (!d || editor().loadError) return;
    const source = nodeAt(d, req.sourcePath);
    const target = nodeAt(d, req.targetPath);
    if (!source || !target) return;
    setConnect({
      scope: scopeOf(req.sourcePath),
      from: source.id,
      to: target.id,
      ports: portsOf(source),
      anchor: req.anchor ?? DEFAULT_ANCHOR,
      fromBackHandle: req.fromBackHandle,
    });
  }, []);

  const onChoosePort = (port: string) => {
    if (!connect) return;
    const edge: FlowEdge = { from: connect.from, to: connect.to };
    if (port !== "success") edge.port = port;
    edit((d) => addEdge(d, connect.scope, edge));
    // A back edge needs maxTraversals: open the new edge in the attribute panel.
    const next = editor().def;
    const edgePath = next ? edgePathOf(next, connect.scope, edge) : null;
    if (connect.fromBackHandle && edgePath) editor().select({ kind: "edge", path: edgePath });
    setConnect(null);
  };

  const onDeleteSelection = useCallback(() => {
    const sel = editor().selection;
    if (sel?.kind === "node") edit((d) => removeNode(d, sel.path));
    else if (sel?.kind === "edge") edit((d) => removeEdge(d, sel.path));
    else return;
    editor().select(null);
  }, [edit]);

  const onAddNode = (node: FlowNode) => {
    edit((d) => addNode(d, node));
    const next = editor().def;
    const index = next ? next.nodes.findIndex((n) => n.id === node.id) : -1;
    if (index >= 0) editor().select({ kind: "node", path: `nodes[${index}]` });
  };

  const markers = useMemo(() => parseErrorMarkers(errors), [errors]);

  if (!folder || !path) {
    return <div className="flow-workspace flow-workspace--empty">{t("workspace.noSelection")}</div>;
  }

  const showEditor = current && !loading;
  const allIssues = [...errors, ...warnings];

  return (
    <div className="flow-workspace" onKeyDown={onKeyDown}>
      <div className="flow-workspace__header">
        <div className="flow-workspace__title">
          <span className="flow-workspace__name">{(current && def?.name) || path}</span>
          <span className="flow-workspace__path">
            {path}
            {showEditor && format && ` · ${format.toUpperCase()}`}
          </span>
        </div>
        {showEditor && dirty && <span className="flow-workspace__dirty">{t("editor.unsaved")}</span>}
        {showEditor && !dirty && justSaved && <span className="flow-workspace__saved">{t("editor.saved")}</span>}
        {showEditor && readOnly && <span className="flow-workspace__readonly">{t("workspace.readOnly")}</span>}
        <button type="button" className="flow-workspace__reload" onClick={() => void editor().reload()}>
          {t("workspace.reload")}
        </button>
      </div>
      {showEditor && (
        <FlowToolbar
          editable={!readOnly}
          canAddNode={def !== null}
          yamlOpen={yamlOpen}
          validating={validating}
          saving={saving}
          onSave={() => void runSave()}
          onValidate={() => void editor().validateNow()}
          onToggleYaml={() => setYamlOpen((open) => !open)}
          renderPalette={(close) =>
            def && (
              <NodePalette
                projectRoot={folder}
                currentFile={path}
                def={def}
                parts={parts}
                project={project}
                onAdd={onAddNode}
                onClose={close}
              />
            )
          }
        />
      )}
      {showEditor && externalChange && (
        <ExternalChangeNotice busy={noticeBusy} onReload={() => void onReloadOutside()} onOverwrite={() => void onOverwrite()} />
      )}
      {showEditor && saveError && (
        <div className="flow-workspace__message flow-workspace__message--error" role="alert">
          {t("editor.saveFailed", { code: saveError })}
        </div>
      )}
      {(!current || loading) && <div className="flow-workspace__message">{t("workspace.loading")}</div>}
      {showEditor && loadError && (
        <div className="flow-workspace__message flow-workspace__message--error">
          {t("workspace.loadFailed", { code: loadError })}
        </div>
      )}
      {showEditor && (
        <div className="flow-workspace__body">
          <div className={`flow-workspace__main${yamlOpen ? " flow-workspace--split" : ""}`}>
            <div className="flow-workspace__canvas">
              {!def && <div className="flow-workspace__message">{t("workspace.notDecoded")}</div>}
              {layoutFailed && (
                <div className="flow-workspace__message flow-workspace__message--error">{t("workspace.layoutFailed")}</div>
              )}
              {graph && layout && (
                <FlowCanvas
                  graph={graph}
                  layout={layout}
                  selection={selection}
                  editable={!readOnly}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onMoveNode={onMoveNode}
                  onConnect={onConnect}
                  onDeleteSelection={onDeleteSelection}
                />
              )}
              {/* Same origin as the canvas wrapper (it fills this box), so the drop point lines up. */}
              {connect && (
                <PortPopover ports={connect.ports} anchor={connect.anchor} onChoose={onChoosePort} onCancel={() => setConnect(null)} />
              )}
            </div>
            {yamlOpen && (
              <div className="flow-workspace__yaml">
                <FlowYamlPane value={text} onChange={setText} readOnly={readOnly} markers={markers} />
              </div>
            )}
          </div>
          <aside className="flow-workspace__side">
            <section className="flow-workspace__section">
              <h3 className="flow-workspace__section-title">{t("run.title")}</h3>
              {kind === "part" && <div className="flow-workspace__message">{t("run.partHint")}</div>}
              <RunPanel
                projectRoot={folder}
                flowPath={path}
                flow={kind === "entry" && def && !dirty && errors.length === 0 ? def : null}
              />
            </section>
            <section className="flow-workspace__section">
              <h3 className="flow-workspace__section-title">{t("workspace.issues")}</h3>
              <FlowIssueList
                errors={errors}
                warnings={warnings}
                onSelectNode={(nodePath) => editor().select(nodePath ? { kind: "node", path: nodePath } : null)}
              />
            </section>
            {def && !readOnly && (
              <section className="flow-workspace__section">
                <AttributePanel
                  def={def}
                  selection={selection}
                  issues={allIssues}
                  parts={parts}
                  project={project}
                  projectRoot={folder}
                  currentFile={path}
                  onEditNode={(p, patch) => edit((d) => updateNode(d, p, patch))}
                  onRenameNode={(p, id) => edit((d) => renameNode(d, p, id))}
                  onEditEdge={(p, patch) => edit((d) => updateEdge(d, p, patch))}
                  onDeleteEdge={(p) => {
                    edit((d) => removeEdge(d, p));
                    editor().select(null);
                  }}
                  onEditFlow={(patch: FlowAttrsPatch) => edit((d) => updateFlowAttrs(d, patch))}
                />
              </section>
            )}
          </aside>
        </div>
      )}
      {confirm && (
        <SaveWarningDialog message={confirm.message} onContinue={() => confirm.resolve(true)} onCancel={() => confirm.resolve(false)} />
      )}
    </div>
  );
}
