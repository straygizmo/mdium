import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import type { FlowDef, FlowEdge, FlowIssue, FlowNode, FlowSummary, ProjectLoadResult } from "@/shared/types/flow";
import { flowApi } from "../lib/flow-api";
import { buildFlowGraph, type CalleeSignature } from "../lib/flow-graph";
import { layoutFlowGraph, savedPositions, type FlowLayout } from "../lib/flow-layout";
import {
  addEdge,
  addNode,
  edgePathOf,
  moveNode,
  nodeAt,
  removeEdge,
  removeNode,
  renameNode,
  scopeOf,
  updateEdge,
  updateFlowAttrs,
  updateNode,
} from "../lib/editor-state";
import { portsOf } from "../lib/flow-ports";
import { useFlowViewStore } from "../flow-store";
import { commentLossDue, confirmDiscard, droppedUnknownKeys, useFlowEditorStore, type Selection } from "../editor-store";
import { commitExtraction } from "../lib/extract-commit";
import { describeError } from "../lib/run-format";
import { FlowCanvas, type ConnectRequest, type NodeMove } from "./FlowCanvas";
import { FlowIssueList } from "./FlowIssueList";
import { FlowToolbar } from "./FlowToolbar";
import { FlowYamlPane, parseErrorMarkers } from "./FlowYamlPane";
import { NodePalette } from "./NodePalette";
import { PortPopover } from "./PortPopover";
import { RunPanel } from "./RunPanel";
import { ExtractDialog } from "./ExtractDialog";
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

/** The discard question in flight, so a re-run effect (StrictMode) does not ask twice. */
let pendingDiscard: { key: string; answer: Promise<boolean> } | null = null;

function askDiscardFor(key: string, message: string): Promise<boolean> {
  if (pendingDiscard?.key === key) return pendingDiscard.answer;
  const answer = confirmDiscard(message).finally(() => {
    if (pendingDiscard?.answer === answer) pendingDiscard = null;
  });
  pendingDiscard = { key, answer };
  return answer;
}

/** Main area of the Flows view: the selected flow's editor (canvas, YAML, attributes, runs). */
export function FlowWorkspace() {
  const { t } = useTranslation("flow");
  const folder = useTabStore((s) => s.activeFolderPath);
  const path = useFlowViewStore((s) => (folder ? s.selected[folder] : undefined));
  const trail = useFlowViewStore((s) => (folder ? s.stack[folder] : undefined));

  const storePath = useFlowEditorStore((s) => s.path);
  const storeRoot = useFlowEditorStore((s) => s.projectRoot);
  const text = useFlowEditorStore((s) => s.text);
  const def = useFlowEditorStore((s) => s.def);
  const defCurrent = useFlowEditorStore((s) => s.defCurrent);
  const kind = useFlowEditorStore((s) => s.kind);
  const format = useFlowEditorStore((s) => s.format);
  const errors = useFlowEditorStore((s) => s.errors);
  const warnings = useFlowEditorStore((s) => s.warnings);
  const dirty = useFlowEditorStore((s) => s.dirty);
  const validating = useFlowEditorStore((s) => s.validating);
  const selection = useFlowEditorStore((s) => s.selection);
  const selectedMany = useFlowEditorStore((s) => s.selectedMany);
  const externalChange = useFlowEditorStore((s) => s.externalChange);
  const externalDeleted = useFlowEditorStore((s) => s.externalDeleted);
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
  const [extracting, setExtracting] = useState<{ busy: boolean; failure: FlowIssue[] } | null>(null);
  const [partsVersion, setPartsVersion] = useState(0);
  const [parts, setParts] = useState<FlowSummary[]>([]);
  const [signatures, setSignatures] = useState<Record<string, CalleeSignature>>({});
  const [project, setProject] = useState<ProjectLoadResult | null>(null);
  const savingRef = useRef(false);
  const confirmRef = useRef<PendingConfirm | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The store holds the file this workspace shows (it may already hold it, e.g. a flow just created).
  const current = !!folder && !!path && storeRoot === folder && storePath === path;
  const readOnly = loadError !== null;
  // Canvas, palette and forms edit `def`; while the YAML holds undecoded edits they would overwrite them.
  const structural = !readOnly && defCurrent;
  const loading = current && kind === null && loadError === null && def === null;

  // The editor state outlives this view (no close on unmount): a remount showing the same
  // file reuses it, edits included. Replacing a dirty file needs the user's consent.
  useEffect(() => {
    setCollapsed(new Set());
    setConnect(null);
    setJustSaved(false);
    if (!folder || !path) return;
    const s = editor();
    if (s.projectRoot === folder && s.path === path) {
      // The file may have changed while no watcher was running: a cheap hash check.
      void s.syncWithDisk();
      return;
    }
    let cancelled = false;
    const held = { root: s.projectRoot, path: s.path };
    void askDiscardFor(`${folder}\n${path}`, t("editor.discardEdits")).then((ok) => {
      if (cancelled) return;
      if (ok) {
        void editor().open(folder, path);
        return;
      }
      // Declined: keep the open file selected (and its breadcrumb trail, when it is on it).
      const view = useFlowViewStore.getState();
      const index = (view.stack[folder] ?? []).findLastIndex((entry) => entry.path === held.path);
      if (held.root === folder && index >= 0) view.popTo(folder, index);
      else if (held.root === folder) view.setSelected(folder, held.path);
      else view.setSelected(folder, null);
    });
    return () => {
      cancelled = true;
    };
    // `t` is stable per language; re-running on a language change must not re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, path]);

  // Parts (for the palette and the sub-flow / loop forms) and the project manifest.
  // `partsVersion` is bumped to re-read the list after a file was created (extraction).
  useEffect(() => {
    if (!folder || !path) return;
    let cancelled = false;
    flowApi.list(folder).then(
      (flows) => {
        if (cancelled) return;
        setParts(flows.filter((f) => f.kind === "part" && f.path !== path));
        // Any in-project flow can be a sub-flow callee, so the map covers entries and parts.
        setSignatures(
          Object.fromEntries(flows.map((f) => [f.path.replace(/\\/g, "/"), { params: f.params, outputs: f.outputs }] as const)),
        );
      },
      () => {
        if (cancelled) return;
        setParts([]);
        setSignatures({});
      },
    );
    flowApi.projectLoad(folder).then(
      (loaded) => !cancelled && setProject(loaded),
      () => !cancelled && setProject(null),
    );
    return () => {
      cancelled = true;
    };
  }, [folder, path, partsVersion]);

  // External changes: compare the hash on disk with the one the editor holds.
  useEffect(() => {
    if (!folder || !path) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const onFolderChanged = async () => {
      const before = editor();
      if (cancelled || before.projectRoot !== folder || before.path !== path) return;
      // Opening another file bumps the store's generation, so a late result is dropped there.
      await before.syncWithDisk();
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
  const graph = useMemo(
    () => (current && def ? buildFlowGraph(def, collapsed, issues, signatures, path ?? "") : null),
    [current, def, collapsed, issues, signatures, path],
  );

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

  /** Validates, asks about errors / dropped keys / lost comments, then saves (or overwrites). */
  const runSave = useCallback(
    async (overwrite = false) => {
      if (savingRef.current || !current || editor().loadError) return;
      savingRef.current = true;
      setSaving(true);
      if (overwrite) setNoticeBusy(true);
      try {
        // A field that commits on blur must reach the text before it is validated and saved.
        const active = document.activeElement;
        if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
        await editor().validateNow();
        const lines: string[] = [];
        const dropped = droppedUnknownKeys(editor());
        if (dropped.length > 0) lines.push(t("editor.droppedKeys", { keys: dropped.join(", ") }));
        if (editor().errors.length > 0) lines.push(t("editor.saveWithErrors"));
        if (lines.length > 0 && !(await ask(lines.join("\n")))) return;
        if (commentLossDue(editor())) {
          if (!(await ask(t("editor.commentLoss")))) return;
          useFlowEditorStore.setState({ commentWarningPending: false });
        }
        const outcome = await editor().save({ overwrite });
        if (outcome === "saved") setJustSaved(true);
      } finally {
        savingRef.current = false;
        setSaving(false);
        if (overwrite) setNoticeBusy(false);
      }
    },
    [current, ask, t],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void runSave();
    }
  };

  const onReloadHeader = async () => {
    if (!current) return;
    if (!(await confirmDiscard(t("editor.discardEdits")))) return;
    setJustSaved(false);
    await editor().reload();
  };

  const onReloadOutside = async () => {
    setNoticeBusy(true);
    try {
      await editor().reload();
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
  const onSelectMany = useCallback((paths: string[]) => editor().selectMany(paths), []);
  const onMoveNodes = useCallback(
    (moves: NodeMove[]) => {
      // Place the node at the drop point in the current layout first: the edit re-derives the
      // canvas nodes from this layout before the async re-layout (which reads ui.positions) lands.
      const keys = moves.map(({ nodeId, position }) => {
        const index = editor().def?.nodes.findIndex((n) => n.id === nodeId) ?? -1;
        return { key: `nodes[${index}]`, index, position };
      });
      setLayout((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        for (const { key, index, position } of keys) {
          if (index >= 0 && next[key]) next[key] = { ...next[key], x: position.x, y: position.y };
        }
        return next;
      });
      // One edit for the whole drag: one validation and one text rewrite.
      edit((d) => moves.reduce((acc, { nodeId, position }) => moveNode(acc, nodeId, position), d));
    },
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

  /** Extracts the selected nodes into a new part; keeps the dialog open (and writes nothing) on errors. */
  const onConfirmExtract = async (name: string) => {
    const s = editor();
    if (!s.def || !s.projectRoot || !s.path || !s.defCurrent) return;
    setExtracting({ busy: true, failure: [] });
    try {
      const outcome = await commitExtraction({
        projectRoot: s.projectRoot,
        def: s.def,
        selectedPaths: s.selectedMany,
        name,
        currentFile: s.path,
      });
      if (!outcome.ok) {
        setExtracting({ busy: false, failure: outcome.errors });
        return;
      }
      edit(() => outcome.updated);
      if (outcome.newNodePath) editor().select({ kind: "node", path: outcome.newNodePath });
      setPartsVersion((v) => v + 1);
      setExtracting(null);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? "FLOW_SAVE_FAILED";
      setExtracting({ busy: false, failure: [{ code, path: "", params: {} } as FlowIssue] });
    }
  };

  /** Opens the file a sub-flow / loop node calls, extending the breadcrumb trail. */
  const onDrill = useCallback(
    (nodePath: string) => {
      const view = useFlowViewStore.getState();
      const node = graph?.nodes.find((n) => n.id === nodePath);
      if (!folder || !path || !node?.signature) return;
      // The first drill seeds the trail with the root flow the user selected.
      if (!view.stack[folder]?.length) view.push(folder, { path, label: editor().def?.name || path.split("/").pop() || path });
      view.push(folder, { path: node.signature.file, label: node.label });
    },
    [graph, folder, path],
  );

  const markers = useMemo(() => parseErrorMarkers(errors), [errors]);

  if (!folder || !path) {
    return <div className="flow-workspace flow-workspace--empty">{t("workspace.noSelection")}</div>;
  }

  const showEditor = current && !loading;
  const allIssues = [...errors, ...warnings];

  return (
    <div ref={rootRef} className="flow-workspace" onKeyDown={onKeyDown}>
      <div className="flow-workspace__header">
        <div className="flow-workspace__title">
          {trail && trail.length > 1 ? (
            <nav className="flow-workspace__crumbs">
              {trail.map((entry, i) => (
                <span key={i} className="flow-workspace__crumb-item">
                  {i > 0 && <span className="flow-workspace__crumb-sep"> › </span>}
                  <button
                    type="button"
                    className="flow-workspace__crumb"
                    disabled={i === trail.length - 1}
                    onClick={() => folder && useFlowViewStore.getState().popTo(folder, i)}
                  >
                    {entry.label}
                  </button>
                </span>
              ))}
            </nav>
          ) : (
            <span className="flow-workspace__name">{(current && def?.name) || path}</span>
          )}
          <span className="flow-workspace__path">
            {path}
            {showEditor && format && ` · ${format.toUpperCase()}`}
          </span>
        </div>
        {showEditor && dirty && <span className="flow-workspace__dirty">{t("editor.unsaved")}</span>}
        {showEditor && !dirty && justSaved && <span className="flow-workspace__saved">{t("editor.saved")}</span>}
        {showEditor && readOnly && <span className="flow-workspace__readonly">{t("workspace.readOnly")}</span>}
        <button type="button" className="flow-workspace__reload" onClick={() => void onReloadHeader()}>
          {t("workspace.reload")}
        </button>
      </div>
      {showEditor && (
        <FlowToolbar
          editable={!readOnly}
          canAddNode={def !== null && structural}
          yamlOpen={yamlOpen}
          validating={validating}
          saving={saving}
          selectedCount={selectedMany.length}
          onExtract={() => setExtracting({ busy: false, failure: [] })}
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
        <ExternalChangeNotice
          busy={noticeBusy}
          deleted={externalDeleted}
          onReload={() => void onReloadOutside()}
          onOverwrite={() => void runSave(true)}
        />
      )}
      {showEditor && saveError && (
        <div className="flow-workspace__message flow-workspace__message--error" role="alert">
          {t("editor.saveFailed", { message: describeError(t, { code: saveError, message: "" }).message })}
        </div>
      )}
      {showEditor && !readOnly && def && !defCurrent && !validating && (
        <div className="flow-workspace__message">{t("editor.fixYamlToEdit")}</div>
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
                  selectedMany={selectedMany}
                  editable={structural}
                  onSelect={onSelect}
                  onSelectMany={onSelectMany}
                  onToggle={onToggle}
                  onMoveNodes={onMoveNodes}
                  onConnect={onConnect}
                  onDeleteSelection={onDeleteSelection}
                  onDrill={onDrill}
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
              <fieldset className="flow-workspace__section flow-workspace__attrs" disabled={!defCurrent}>
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
              </fieldset>
            )}
          </aside>
        </div>
      )}
      {extracting && def && (
        <ExtractDialog
          def={def}
          selectedPaths={selectedMany}
          currentFile={path}
          existingParts={parts.map((p) => p.path)}
          failure={extracting.failure}
          busy={extracting.busy}
          onConfirm={(name) => void onConfirmExtract(name)}
          onClose={() => setExtracting(null)}
        />
      )}
      {confirm && (
        <SaveWarningDialog message={confirm.message} onContinue={() => confirm.resolve(true)} onCancel={() => confirm.resolve(false)} />
      )}
    </div>
  );
}
