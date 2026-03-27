import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { KityMinderJson, KityMinderNode, MindmapInternalNode } from "../lib/types";
import { parseXmindFile } from "../lib/xmind-parser";
import { getThemeColors } from "../lib/themes";
import {
  computeLayout,
  assignIds,
  cloneTree,
  findNode,
  findParent,
  stripIds,
  type LayoutDirection,
} from "../lib/layout";
import MindmapNodeComponent from "./MindmapNode";
import MindmapEdgeComponent from "./MindmapEdge";
import MindmapToolbar from "./MindmapToolbar";
import "./MindmapEditor.css";

const MAX_UNDO = 100;
const URL_REGEX = /^(https?|ftp):\/\/.+/i;

// Module-level viewport cache (persists across remounts)
const viewportCache = new Map<string, Viewport>();

const nodeTypes = { mindmap: MindmapNodeComponent };
const edgeTypes = { mindmap: MindmapEdgeComponent };

// --- Pure DOM dialogs (hyperlink, image) reused from original ---

function showHyperlinkDialog(
  existing: { url?: string; title?: string } | null,
  onOk: (url: string, title: string) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "km-modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "km-modal-dialog";

  const header = document.createElement("div");
  header.className = "km-modal-header";
  header.innerHTML = `<span>リンク</span><button class="km-modal-close">&times;</button>`;

  const body = document.createElement("div");
  body.className = "km-modal-body";
  body.innerHTML = `
    <label>URL</label>
    <input type="text" id="km-link-url" placeholder="https://example.com" />
    <div class="km-error-text" id="km-link-error" style="display:none">有効なURL (http/https/ftp) を入力してください</div>
    <label>タイトル (任意)</label>
    <input type="text" id="km-link-title" placeholder="リンクのタイトル" />
  `;

  const footer = document.createElement("div");
  footer.className = "km-modal-footer";
  footer.innerHTML = `
    <button class="km-btn-cancel">キャンセル</button>
    <button class="km-btn-primary" id="km-link-ok">OK</button>
  `;

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const urlInput = body.querySelector("#km-link-url") as HTMLInputElement;
  const titleInput = body.querySelector("#km-link-title") as HTMLInputElement;
  const errorDiv = body.querySelector("#km-link-error") as HTMLDivElement;

  if (existing?.url) {
    urlInput.value = existing.url;
    titleInput.value = existing.title || "";
  }

  const close = () => overlay.remove();
  const ok = () => {
    const url = urlInput.value.trim();
    if (!URL_REGEX.test(url)) {
      errorDiv.style.display = "";
      urlInput.focus();
      return;
    }
    close();
    onOk(url, titleInput.value.trim());
  };

  header.querySelector(".km-modal-close")!.addEventListener("click", close);
  footer.querySelector(".km-btn-cancel")!.addEventListener("click", close);
  footer.querySelector("#km-link-ok")!.addEventListener("click", ok);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  urlInput.addEventListener("input", () => { errorDiv.style.display = "none"; });
  urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") close(); });
  titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") close(); });
  requestAnimationFrame(() => { urlInput.focus(); urlInput.select(); });
}

function showImageDialog(
  existing: { url?: string; title?: string } | null,
  onOk: (url: string, title: string) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "km-modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "km-modal-dialog";

  const header = document.createElement("div");
  header.className = "km-modal-header";
  header.innerHTML = `<span>画像</span><button class="km-modal-close">&times;</button>`;

  const body = document.createElement("div");
  body.className = "km-modal-body";
  body.innerHTML = `
    <div class="km-tab-bar">
      <button class="km-tab-active" data-tab="url">URL指定</button>
      <button data-tab="file">ファイル選択</button>
    </div>
    <div id="km-img-tab-url">
      <label>画像URL</label>
      <input type="text" id="km-img-url" placeholder="https://example.com/image.png" />
      <label>タイトル (任意)</label>
      <input type="text" id="km-img-title" placeholder="画像のタイトル" />
    </div>
    <div id="km-img-tab-file" style="display:none">
      <div class="km-file-input-wrapper">
        <input type="file" id="km-img-file" accept="image/*" />
      </div>
    </div>
    <img class="km-image-preview" id="km-img-preview" style="display:none" />
  `;

  const footer = document.createElement("div");
  footer.className = "km-modal-footer";
  footer.innerHTML = `
    <button class="km-btn-cancel">キャンセル</button>
    <button class="km-btn-primary" id="km-img-ok">OK</button>
  `;

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const urlInput = body.querySelector("#km-img-url") as HTMLInputElement;
  const titleInput = body.querySelector("#km-img-title") as HTMLInputElement;
  const fileInput = body.querySelector("#km-img-file") as HTMLInputElement;
  const preview = body.querySelector("#km-img-preview") as HTMLImageElement;
  const tabUrl = body.querySelector("#km-img-tab-url") as HTMLDivElement;
  const tabFile = body.querySelector("#km-img-tab-file") as HTMLDivElement;
  const tabButtons = body.querySelectorAll(".km-tab-bar button");

  let currentUrl = existing?.url || "";
  let currentTitle = existing?.title || "";

  if (currentUrl) {
    urlInput.value = currentUrl;
    titleInput.value = currentTitle;
    preview.src = currentUrl;
    preview.style.display = "";
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabButtons.forEach((b) => b.classList.remove("km-tab-active"));
      btn.classList.add("km-tab-active");
      const tab = btn.getAttribute("data-tab");
      tabUrl.style.display = tab === "url" ? "" : "none";
      tabFile.style.display = tab === "file" ? "" : "none";
    });
  });

  urlInput.addEventListener("blur", () => {
    const url = urlInput.value.trim();
    if (url) { currentUrl = url; preview.src = url; preview.style.display = ""; }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      currentUrl = reader.result as string;
      currentTitle = titleInput.value.trim() || file.name;
      preview.src = currentUrl;
      preview.style.display = "";
    };
    reader.readAsDataURL(file);
  });

  const close = () => overlay.remove();
  const ok = () => {
    const url = currentUrl || urlInput.value.trim();
    if (!url) return;
    close();
    onOk(url, titleInput.value.trim() || currentTitle);
  };

  header.querySelector(".km-modal-close")!.addEventListener("click", close);
  footer.querySelector(".km-btn-cancel")!.addEventListener("click", close);
  footer.querySelector("#km-img-ok")!.addEventListener("click", ok);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  requestAnimationFrame(() => urlInput.focus());
}

// --- Types ---

interface Props {
  fileData: Uint8Array;
  fileType: string;
  filePath: string;
  theme: "light" | "dark";
  onSave: (json: KityMinderJson) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export interface MindmapEditorHandle {
  getJson: () => KityMinderJson | null;
}

// --- Inner component (needs ReactFlowProvider) ---

interface InnerProps extends Props {
  editorRef: React.Ref<MindmapEditorHandle>;
}

function MindmapEditorInner({ fileData, fileType, filePath, theme, onSave, onDirtyChange, editorRef }: InnerProps) {
  const readOnly = fileType === ".xmind";
  const { fitView, setViewport, getNodes } = useReactFlow();

  // Core state
  const [tree, setTree] = useState<MindmapInternalNode | null>(null);
  const [currentTheme, setCurrentTheme] = useState("fresh-blue");
  const [currentLayout, setCurrentLayout] = useState<LayoutDirection>("right");
  const [error, setError] = useState<string | null>(null);
  const [, setDirty] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const selectedNodeId = useMemo(() => {
    if (selectedNodeIds.size === 0) return null;
    let last: string | null = null;
    for (const id of selectedNodeIds) last = id;
    return last;
  }, [selectedNodeIds]);
  const selectNode = useCallback((id: string | null) => {
    setSelectedNodeIds(id ? new Set([id]) : new Set());
  }, []);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);

  // Note panel
  const [notePanel, setNotePanel] = useState<{ nodeId: string; text: string; x: number; y: number } | null>(null);
  const notePanelDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Drag-to-reparent state
  const dragRef = useRef<{ draggedId: string; currentDropTarget: string | null } | null>(null);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Clipboard (app-internal, stores subtree without IDs)
  const clipboardRef = useRef<KityMinderNode | null>(null);

  // Undo/Redo
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const dirtyRef = useRef(false);
  const treeRef = useRef<MindmapInternalNode | null>(null);
  treeRef.current = tree;

  // Export handle
  useImperativeHandle(editorRef, () => ({
    getJson: () => {
      if (!treeRef.current) return null;
      const root = stripIds(treeRef.current);
      return { root, theme: currentTheme, template: currentLayout } as KityMinderJson;
    },
  }));

  const markDirty = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
      onDirtyChange(true);
    }
  }, [onDirtyChange]);

  const pushSnapshot = useCallback(() => {
    if (!treeRef.current) return;
    const json = JSON.stringify(stripIds(treeRef.current));
    const stack = undoStackRef.current;
    if (stack.length > 0 && stack[stack.length - 1] === json) return;
    stack.push(json);
    if (stack.length > MAX_UNDO) stack.shift();
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0 || !treeRef.current) return;
    redoStackRef.current.push(JSON.stringify(stripIds(treeRef.current)));
    const prev = JSON.parse(undoStackRef.current.pop()!);
    setTree(assignIds(prev));
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }, []);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0 || !treeRef.current) return;
    undoStackRef.current.push(JSON.stringify(stripIds(treeRef.current)));
    const next = JSON.parse(redoStackRef.current.pop()!);
    setTree(assignIds(next));
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  // Compute layout
  const themeColors = useMemo(() => getThemeColors(currentTheme), [currentTheme]);
  const { nodes, edges } = useMemo(() => {
    if (!tree) return { nodes: [], edges: [] };
    return computeLayout(tree, currentLayout, themeColors);
  }, [tree, currentLayout, themeColors]);

  // Add editing overlay data to nodes
  const displayNodes = useMemo(() => {
    return nodes.map((n) => ({
      ...n,
      selected: selectedNodeIds.has(n.id),
      draggable: !readOnly && !(n.data as Record<string, unknown>).isRoot,
      data: { ...n.data, isDropTarget: n.id === dropTargetId },
    }));
  }, [nodes, selectedNodeIds, readOnly, dropTargetId]);

  // Preview edge for drag-to-reparent
  const displayEdges = useMemo(() => {
    if (!dropTargetId || !draggedNodeId) return edges;
    let sourceHandle: string;
    let targetHandle: string;
    if (currentLayout === "bottom") {
      sourceHandle = "source-bottom";
      targetHandle = "target-top";
    } else if (currentLayout === "filetree") {
      sourceHandle = "source-bottom";
      targetHandle = "target-left";
    } else {
      const targetNode = nodes.find((n) => n.id === dropTargetId);
      const dir = (targetNode?.data as Record<string, unknown>)?.direction as string;
      if (dir === "left") {
        sourceHandle = "source-left";
        targetHandle = "target-right";
      } else {
        sourceHandle = "source-right";
        targetHandle = "target-left";
      }
    }
    const previewEdge: Edge = {
      id: "preview-drop-edge",
      source: dropTargetId,
      target: draggedNodeId,
      sourceHandle,
      targetHandle,
      type: "mindmap",
      data: { color: "#1976d2", depth: 1 } as unknown as Record<string, unknown>,
      style: { strokeDasharray: "6 3" },
    };
    return [...edges, previewEdge];
  }, [edges, dropTargetId, draggedNodeId, currentLayout, nodes]);

  // Load data
  useEffect(() => {
    const load = async () => {
      try {
        let jsonData: KityMinderJson;
        if (fileType === ".xmind") {
          jsonData = await parseXmindFile(fileData);
        } else {
          const text = new TextDecoder().decode(fileData);
          jsonData = JSON.parse(text) as KityMinderJson;
        }

        const internal = assignIds(jsonData.root);
        setTree(internal);
        selectNode(internal.id);

        if (jsonData.theme) setCurrentTheme(jsonData.theme);
        if (jsonData.template) {
          const layout = jsonData.template === "default" ? "right" : jsonData.template;
          setCurrentLayout(layout as LayoutDirection);
        }

        undoStackRef.current = [];
        redoStackRef.current = [];
        setCanUndo(false);
        setCanRedo(false);
        setDirty(false);
        dirtyRef.current = false;
        onDirtyChange(false);
        setEditingNodeId(null);
        setContextMenu(null);
        setNotePanel(null);

        // Restore viewport after render
        const vp = viewportCache.get(filePath);
        requestAnimationFrame(() => {
          if (vp) {
            setViewport(vp);
          } else {
            fitView({ padding: 0.2 });
          }
        });
      } catch (e) {
        setError(`ファイルの読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileData, fileType, filePath]);

  // Save handler
  const handleSave = useCallback(() => {
    if (!treeRef.current) return;
    const root = stripIds(treeRef.current);
    const json: KityMinderJson = { root, theme: currentTheme, template: currentLayout };
    onSave(json);
    setDirty(false);
    dirtyRef.current = false;
    onDirtyChange(false);
  }, [currentTheme, currentLayout, onSave, onDirtyChange]);

  // --- Tree mutation helpers ---

  const mutateTree = useCallback(
    (fn: (clone: MindmapInternalNode) => void) => {
      if (!treeRef.current) return;
      pushSnapshot();
      const clone = cloneTree(treeRef.current);
      fn(clone);
      setTree(clone);
      markDirty();
    },
    [pushSnapshot, markDirty],
  );

  const insertChild = useCallback(
    (parentId: string): string | null => {
      if (!treeRef.current) return null;
      pushSnapshot();
      const clone = cloneTree(treeRef.current);
      const parent = findNode(clone, parentId);
      if (!parent) return null;
      const newId = crypto.randomUUID();
      const childNum = parent.children.length + 1;
      const isRoot = parent.id === clone.id;
      parent.children.push({
        id: newId,
        data: { text: isRoot ? `主トピック ${childNum}` : `サブトピック ${childNum}` },
        children: [],
      });
      setTree(clone);
      markDirty();
      return newId;
    },
    [pushSnapshot, markDirty],
  );

  const insertSibling = useCallback(
    (nodeId: string): string | null => {
      if (!treeRef.current) return null;
      const result = findParent(treeRef.current, nodeId);
      if (!result) return null; // root has no parent
      pushSnapshot();
      const clone = cloneTree(treeRef.current);
      const parentResult = findParent(clone, nodeId);
      if (!parentResult) return null;
      const { parent, index } = parentResult;
      const newId = crypto.randomUUID();
      const siblingNum = parent.children.length + 1;
      const isParentRoot = parent.id === clone.id;
      parent.children.splice(index + 1, 0, {
        id: newId,
        data: { text: isParentRoot ? `主トピック ${siblingNum}` : `サブトピック ${siblingNum}` },
        children: [],
      });
      setTree(clone);
      markDirty();
      return newId;
    },
    [pushSnapshot, markDirty],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      if (!treeRef.current) return;
      const result = findParent(treeRef.current, nodeId);
      if (!result) return; // can't delete root
      pushSnapshot();
      const clone = cloneTree(treeRef.current);
      const parentResult = findParent(clone, nodeId)!;
      const { parent, index } = parentResult;
      parent.children.splice(index, 1);
      setTree(clone);
      markDirty();
      // Select parent or sibling
      const newSelection = parent.children[Math.min(index, parent.children.length - 1)]?.id || parent.id;
      selectNode(newSelection);
    },
    [pushSnapshot, markDirty],
  );

  // --- Editing ---

  const startEdit = useCallback(
    (nodeId: string) => {
      if (readOnly) return;
      const node = treeRef.current ? findNode(treeRef.current, nodeId) : null;
      if (!node) return;
      setEditingNodeId(nodeId);
      setEditText(node.data.text);
    },
    [readOnly],
  );

  const commitEdit = useCallback(() => {
    if (!editingNodeId || !treeRef.current) return;
    const newText = editText.trim();
    const node = findNode(treeRef.current, editingNodeId);
    if (node && newText && newText !== node.data.text) {
      mutateTree((clone) => {
        const n = findNode(clone, editingNodeId);
        if (n) n.data.text = newText;
      });
    }
    setEditingNodeId(null);
  }, [editingNodeId, editText, mutateTree]);

  const cancelEdit = useCallback(() => {
    setEditingNodeId(null);
  }, []);

  // --- Theme/Layout handlers ---

  const handleChangeTheme = useCallback(
    (themeId: string) => {
      pushSnapshot();
      setCurrentTheme(themeId);
      markDirty();
    },
    [pushSnapshot, markDirty],
  );

  const handleChangeLayout = useCallback(
    (layoutId: string) => {
      pushSnapshot();
      setCurrentLayout(layoutId as LayoutDirection);
      markDirty();
    },
    [pushSnapshot, markDirty],
  );

  // --- Context menu actions ---

  const handleSetPriority = useCallback(
    (nodeId: string, p: number) => {
      mutateTree((clone) => {
        const n = findNode(clone, nodeId);
        if (n) n.data.priority = p || undefined;
      });
      setContextMenu(null);
    },
    [mutateTree],
  );

  const handleSetProgress = useCallback(
    (nodeId: string, p: number) => {
      mutateTree((clone) => {
        const n = findNode(clone, nodeId);
        if (n) n.data.progress = p || undefined;
      });
      setContextMenu(null);
    },
    [mutateTree],
  );

  const handleEditLink = useCallback(
    (nodeId: string) => {
      setContextMenu(null);
      const node = treeRef.current ? findNode(treeRef.current, nodeId) : null;
      showHyperlinkDialog(
        node ? { url: node.data.hyperlink, title: node.data.hyperlinkTitle } : null,
        (url, title) => {
          mutateTree((clone) => {
            const n = findNode(clone, nodeId);
            if (n) {
              n.data.hyperlink = url;
              n.data.hyperlinkTitle = title || undefined;
            }
          });
        },
      );
    },
    [mutateTree],
  );

  const handleDeleteLink = useCallback(
    (nodeId: string) => {
      mutateTree((clone) => {
        const n = findNode(clone, nodeId);
        if (n) {
          n.data.hyperlink = undefined;
          n.data.hyperlinkTitle = undefined;
        }
      });
      setContextMenu(null);
    },
    [mutateTree],
  );

  const handleEditImage = useCallback(
    (nodeId: string) => {
      setContextMenu(null);
      const node = treeRef.current ? findNode(treeRef.current, nodeId) : null;
      showImageDialog(
        node ? { url: node.data.image, title: "" } : null,
        (url, _title) => {
          const img = new Image();
          const applyImage = (w: number, h: number) => {
            const MAX_W = 300;
            let dw = w, dh = h;
            if (dw > MAX_W) { dh = Math.round(dh * MAX_W / dw); dw = MAX_W; }
            mutateTree((clone) => {
              const n = findNode(clone, nodeId);
              if (n) {
                n.data.image = url;
                n.data.imageSize = { width: dw, height: dh };
              }
            });
          };
          img.onload = () => applyImage(img.naturalWidth, img.naturalHeight);
          img.onerror = () => applyImage(200, 200);
          img.src = url;
        },
      );
    },
    [mutateTree],
  );

  const handleDeleteImage = useCallback(
    (nodeId: string) => {
      mutateTree((clone) => {
        const n = findNode(clone, nodeId);
        if (n) {
          n.data.image = undefined;
          n.data.imageSize = undefined;
        }
      });
      setContextMenu(null);
    },
    [mutateTree],
  );

  const handleOpenNote = useCallback(
    (nodeId: string) => {
      setContextMenu(null);
      const node = treeRef.current ? findNode(treeRef.current, nodeId) : null;
      // Position near the node
      const el = document.querySelector(`[data-id="${nodeId}"]`) as HTMLElement | null;
      const container = el?.closest(".mindmap-container") as HTMLElement | null;
      let x = 100, y = 100;
      if (el && container) {
        const rect = el.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        x = rect.right - cRect.left + 12;
        y = rect.top - cRect.top;
        // Keep within container bounds
        const panelW = 320, panelH = 220;
        if (x + panelW > cRect.width) x = rect.left - cRect.left - panelW - 12;
        if (x < 0) x = 12;
        if (y + panelH > cRect.height) y = cRect.height - panelH - 12;
        if (y < 0) y = 12;
      }
      setNotePanel({ nodeId, text: node?.data.note || "", x, y });
    },
    [],
  );

  useEffect(() => {
    const handler = (e: Event) => handleOpenNote((e as CustomEvent).detail);
    window.addEventListener("mindmap-open-note", handler);
    return () => window.removeEventListener("mindmap-open-note", handler);
  }, [handleOpenNote]);

  const handleDeleteNote = useCallback(
    (nodeId: string) => {
      mutateTree((clone) => {
        const n = findNode(clone, nodeId);
        if (n) n.data.note = undefined;
      });
      setContextMenu(null);
      if (notePanel?.nodeId === nodeId) setNotePanel(null);
    },
    [mutateTree, notePanel],
  );

  const handleNoteChange = useCallback(
    (text: string) => {
      if (!notePanel) return;
      setNotePanel((prev) => (prev ? { ...prev, text } : null));
      mutateTree((clone) => {
        const n = findNode(clone, notePanel.nodeId);
        if (n) n.data.note = text || undefined;
      });
    },
    [notePanel, mutateTree],
  );

  // --- Copy / Cut / Paste ---

  const handleCopy = useCallback(() => {
    if (!selectedNodeId || !treeRef.current) return;
    const node = findNode(treeRef.current, selectedNodeId);
    if (!node) return;
    clipboardRef.current = stripIds(node);
  }, [selectedNodeId]);

  const handleCut = useCallback(() => {
    if (!selectedNodeId || !treeRef.current) return;
    if (selectedNodeId === treeRef.current.id) return; // can't cut root
    const node = findNode(treeRef.current, selectedNodeId);
    if (!node) return;
    clipboardRef.current = stripIds(node);
    deleteNode(selectedNodeId);
  }, [selectedNodeId, deleteNode]);

  const handlePaste = useCallback(() => {
    if (!clipboardRef.current || !selectedNodeId || !treeRef.current) return;
    const clipboard = clipboardRef.current;
    mutateTree((clone) => {
      const parent = findNode(clone, selectedNodeId);
      if (!parent) return;
      const newChild = assignIds(clipboard);
      parent.children.push(newChild);
    });
  }, [selectedNodeId, mutateTree]);

  // --- React Flow event handlers ---

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (editingNodeId && editingNodeId !== node.id) {
        commitEdit();
      }
      setContextMenu(null);
    },
    [editingNodeId, commitEdit],
  );

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      startEdit(node.id);
    },
    [startEdit],
  );

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      if (readOnly) return;
      selectNode(node.id);
      setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
    },
    [readOnly],
  );

  const handlePaneClick = useCallback(() => {
    if (editingNodeId) commitEdit();
    setContextMenu(null);
    setNotePanel(null);
  }, [editingNodeId, commitEdit]);

  const handleSelectionChange = useCallback(
    ({ nodes: selNodes }: { nodes: Node[] }) => {
      setSelectedNodeIds(new Set(selNodes.map((n) => n.id)));
    },
    [],
  );

  const handleMoveEnd = useCallback(
    (_: unknown, viewport: Viewport) => {
      viewportCache.set(filePath, viewport);
    },
    [filePath],
  );

  // --- Drag-to-reparent ---

  const handleNodeDragStart = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (readOnly || !treeRef.current) return;
      if (node.id === treeRef.current.id) return;
      if (editingNodeId) return;
      if (selectedNodeIds.size > 1) return;
      dragRef.current = { draggedId: node.id, currentDropTarget: null };
      setDraggedNodeId(node.id);
    },
    [readOnly, editingNodeId, selectedNodeIds.size],
  );

  const handleNodeDrag = useCallback(
    (_: React.MouseEvent, draggedNode: Node) => {
      if (!dragRef.current || !treeRef.current) return;
      const { draggedId } = dragRef.current;
      const allNodes = getNodes();
      const dw = draggedNode.measured?.width ?? 100;
      const dh = draggedNode.measured?.height ?? 30;
      const dragCx = draggedNode.position.x + dw / 2;
      const dragCy = draggedNode.position.y + dh / 2;

      let closestId: string | null = null;
      let closestDist = Infinity;
      const THRESHOLD = 100;
      const draggedSubtree = findNode(treeRef.current, draggedId);

      for (const n of allNodes) {
        if (n.id === draggedId) continue;
        if (draggedSubtree && findNode(draggedSubtree, n.id)) continue;
        const nw = n.measured?.width ?? 100;
        const nh = n.measured?.height ?? 30;
        const cx = n.position.x + nw / 2;
        const cy = n.position.y + nh / 2;
        const dist = Math.sqrt((cx - dragCx) ** 2 + (cy - dragCy) ** 2);
        if (dist < closestDist && dist < THRESHOLD) {
          closestDist = dist;
          closestId = n.id;
        }
      }

      if (closestId !== dragRef.current.currentDropTarget) {
        dragRef.current.currentDropTarget = closestId;
        setDropTargetId(closestId);
      }
    },
    [getNodes],
  );

  const handleNodeDragStop = useCallback(
    (_: React.MouseEvent, _node: Node) => {
      const dragData = dragRef.current;
      dragRef.current = null;
      setDraggedNodeId(null);
      setDropTargetId(null);

      if (!dragData || !dragData.currentDropTarget || !treeRef.current) return;
      const { draggedId, currentDropTarget: targetId } = dragData;

      pushSnapshot();
      const clone = cloneTree(treeRef.current);
      const parentResult = findParent(clone, draggedId);
      if (!parentResult) return;
      const draggedSubtree = parentResult.parent.children.splice(parentResult.index, 1)[0];
      const newParent = findNode(clone, targetId);
      if (!newParent) return;
      if (newParent.data.expandState === "collapse") {
        newParent.data.expandState = "expand";
      }
      newParent.children.push(draggedSubtree);
      setTree(clone);
      markDirty();
      selectNode(draggedId);
    },
    [pushSnapshot, markDirty, selectNode],
  );

  // --- Keyboard shortcuts ---

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle when editing note
      if (notePanel && document.activeElement?.tagName === "TEXTAREA") return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === "s") {
          e.preventDefault();
          handleSave();
          return;
        }
        if (e.key === "z") {
          e.preventDefault();
          handleUndo();
          return;
        }
        if (e.key === "y") {
          e.preventDefault();
          handleRedo();
          return;
        }
        if (e.key === "c") {
          e.preventDefault();
          handleCopy();
          return;
        }
        if (e.key === "x") {
          e.preventDefault();
          handleCut();
          return;
        }
        if (e.key === "v") {
          e.preventDefault();
          handlePaste();
          return;
        }
      }

      if (readOnly) return;
      if (editingNodeId) return; // handled by edit input

      if (!selectedNodeId || !treeRef.current) return;

      if (e.key === "F2") {
        e.preventDefault();
        startEdit(selectedNodeId);
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selectedNodeIds.size > 1) {
          const idsToDelete = new Set(selectedNodeIds);
          mutateTree((clone) => {
            const removeMarked = (node: MindmapInternalNode) => {
              node.children = node.children.filter((c) => !idsToDelete.has(c.id));
              node.children.forEach(removeMarked);
            };
            removeMarked(clone);
          });
          selectNode(treeRef.current?.id || null);
        } else {
          deleteNode(selectedNodeId);
        }
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const newId = insertChild(selectedNodeId);
        if (newId) {
          selectNode(newId);
          requestAnimationFrame(() => startEdit(newId));
        }
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        // Can't add sibling to root
        if (selectedNodeId === treeRef.current.id) return;
        const newId = insertSibling(selectedNodeId);
        if (newId) {
          selectNode(newId);
          requestAnimationFrame(() => startEdit(newId));
        }
        return;
      }

      // Arrow key navigation
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        navigateArrow(e.key, selectedNodeId, treeRef.current, currentLayout, selectNode);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    readOnly, editingNodeId, selectedNodeId, selectedNodeIds, currentLayout, notePanel,
    handleSave, handleUndo, handleRedo, handleCopy, handleCut, handlePaste,
    startEdit, deleteNode, insertChild, insertSibling, selectNode, mutateTree,
  ]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".km-context-menu")) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  if (error) {
    return <div className="mindmap-error"><p>{error}</p></div>;
  }

  const ctxNode = contextMenu && treeRef.current ? findNode(treeRef.current, contextMenu.nodeId) : null;

  return (
    <div className="mindmap-editor" data-theme={theme}>
      <MindmapToolbar
        currentTheme={currentTheme}
        currentLayout={currentLayout}
        canUndo={canUndo}
        canRedo={canRedo}
        readOnly={readOnly}
        onChangeTheme={handleChangeTheme}
        onChangeLayout={handleChangeLayout}
        onUndo={handleUndo}
        onRedo={handleRedo}
      />
      <div className="mindmap-container">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeContextMenu={handleNodeContextMenu}
          onPaneClick={handlePaneClick}
          onSelectionChange={handleSelectionChange}
          onMoveEnd={handleMoveEnd}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          nodesConnectable={false}
          selectionOnDrag
          panOnDrag={[2]}
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={3}
          fitView={!viewportCache.has(filePath)}
          fitViewOptions={{ padding: 0.2 }}
          defaultViewport={viewportCache.get(filePath)}
          proOptions={{ hideAttribution: true }}
        />

        {/* Inline edit overlay */}
        {editingNodeId && (() => {
          const editNode = nodes.find((n) => n.id === editingNodeId);
          if (!editNode) return null;
          return (
            <EditOverlay
              nodeId={editingNodeId}
              text={editText}
              onChange={setEditText}
              onCommit={commitEdit}
              onCancel={cancelEdit}
            />
          );
        })()}

        {/* Floating note panel */}
        {notePanel && (
          <div
            className="km-note-panel-float"
            style={{ left: notePanel.x, top: notePanel.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              className="km-note-panel-header"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                notePanelDragRef.current = {
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: notePanel.x,
                  origY: notePanel.y,
                };
                const onMove = (ev: MouseEvent) => {
                  const d = notePanelDragRef.current;
                  if (!d) return;
                  setNotePanel((prev) =>
                    prev ? { ...prev, x: d.origX + ev.clientX - d.startX, y: d.origY + ev.clientY - d.startY } : null,
                  );
                };
                const onUp = () => {
                  notePanelDragRef.current = null;
                  document.removeEventListener("mousemove", onMove);
                  document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
              }}
            >
              <span>ノート (Markdown)</span>
              <button onClick={() => setNotePanel(null)} title="閉じる">&times;</button>
            </div>
            <textarea
              value={notePanel.text}
              onChange={(e) => handleNoteChange(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setNotePanel(null);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder="マークダウンテキストを入力..."
            />
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && ctxNode && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          node={ctxNode}
          isRoot={treeRef.current?.id === contextMenu.nodeId}
          onInsertChild={() => {
            const newId = insertChild(contextMenu.nodeId);
            setContextMenu(null);
            if (newId) {
              selectNode(newId);
              requestAnimationFrame(() => startEdit(newId));
            }
          }}
          onInsertSibling={() => {
            const newId = insertSibling(contextMenu.nodeId);
            setContextMenu(null);
            if (newId) {
              selectNode(newId);
              requestAnimationFrame(() => startEdit(newId));
            }
          }}
          onDelete={() => { deleteNode(contextMenu.nodeId); setContextMenu(null); }}
          onCopy={() => { handleCopy(); setContextMenu(null); }}
          onCut={() => { handleCut(); setContextMenu(null); }}
          onPaste={() => { handlePaste(); setContextMenu(null); }}
          hasClipboard={clipboardRef.current !== null}
          onSetPriority={(p) => handleSetPriority(contextMenu.nodeId, p)}
          onSetProgress={(p) => handleSetProgress(contextMenu.nodeId, p)}
          onEditLink={() => handleEditLink(contextMenu.nodeId)}
          onDeleteLink={() => handleDeleteLink(contextMenu.nodeId)}
          onEditImage={() => handleEditImage(contextMenu.nodeId)}
          onDeleteImage={() => handleDeleteImage(contextMenu.nodeId)}
          onEditNote={() => handleOpenNote(contextMenu.nodeId)}
          onDeleteNote={() => handleDeleteNote(contextMenu.nodeId)}
        />
      )}

    </div>
  );
}

// --- Edit overlay component ---

function EditOverlay({
  nodeId,
  text,
  onChange,
  onCommit,
  onCancel,
}: {
  nodeId: string;
  text: string;
  onChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Find the React Flow node element and position overlay on it
    const el = document.querySelector(`[data-id="${nodeId}"]`) as HTMLElement | null;
    const textarea = inputRef.current;
    if (!el || !textarea) return;

    const container = el.closest(".mindmap-container") as HTMLElement;
    if (!container) return;

    const rect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    textarea.style.left = `${rect.left - containerRect.left - 2}px`;
    textarea.style.top = `${rect.top - containerRect.top - 2}px`;
    textarea.style.minWidth = `${rect.width + 8}px`;
    textarea.style.minHeight = `${rect.height + 4}px`;

    textarea.focus();
    textarea.select();
  }, [nodeId]);

  return (
    <textarea
      ref={inputRef}
      className="km-edit-textarea"
      value={text}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={onCommit}
    />
  );
}

// --- Context menu component ---

function ContextMenu({
  x,
  y,
  nodeId: _nodeId,
  node,
  isRoot,
  onInsertChild,
  onInsertSibling,
  onDelete,
  onCopy,
  onCut,
  onPaste,
  hasClipboard,
  onSetPriority,
  onSetProgress,
  onEditLink,
  onDeleteLink,
  onEditImage,
  onDeleteImage,
  onEditNote,
  onDeleteNote,
}: {
  x: number;
  y: number;
  nodeId: string;
  node: MindmapInternalNode;
  isRoot: boolean;
  onInsertChild: () => void;
  onInsertSibling: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  hasClipboard: boolean;
  onSetPriority: (p: number) => void;
  onSetProgress: (p: number) => void;
  onEditLink: () => void;
  onDeleteLink: () => void;
  onEditImage: () => void;
  onDeleteImage: () => void;
  onEditNote: () => void;
  onDeleteNote: () => void;
}) {
  return (
    <div className="km-context-menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {/* Insert */}
      <div className="km-context-menu-item km-has-submenu">
        <span>挿入</span>
        <span className="km-submenu-arrow">▶</span>
        <div className="km-context-submenu">
          {!isRoot && (
            <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onInsertSibling(); }}>
              トピック
            </div>
          )}
          <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onInsertChild(); }}>
            サブトピック
          </div>
        </div>
      </div>

      {/* Copy / Cut / Paste */}
      <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onCopy(); }}>
        コピー
      </div>
      {!isRoot && (
        <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onCut(); }}>
          切り取り
        </div>
      )}
      <div
        className={`km-context-menu-item${hasClipboard ? "" : " km-context-menu-disabled"}`}
        onMouseDown={(e) => { e.stopPropagation(); if (hasClipboard) onPaste(); }}
      >
        貼り付け
      </div>

      <div className="km-context-menu-separator" />

      {/* Markers */}
      <div className="km-context-menu-item km-has-submenu">
        <span>マーカー</span>
        <span className="km-submenu-arrow">▶</span>
        <div className="km-context-submenu">
          <div className="km-context-menu-item km-has-submenu">
            <span>優先度</span>
            <span className="km-submenu-arrow">▶</span>
            <div className="km-context-submenu">
              <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onSetPriority(0); }}>なし</div>
              {[1, 2, 3, 4, 5].map((p) => (
                <div key={p} className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onSetPriority(p); }}>
                  優先度 {p}
                </div>
              ))}
            </div>
          </div>
          <div className="km-context-menu-item km-has-submenu">
            <span>進捗</span>
            <span className="km-submenu-arrow">▶</span>
            <div className="km-context-submenu">
              <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onSetProgress(0); }}>なし</div>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => (
                <div key={p} className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onSetProgress(p); }}>
                  {Math.round(((p - 1) / 8) * 100)}%
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="km-context-menu-separator" />

      {/* Link */}
      <div className="km-context-menu-item km-has-submenu">
        <span>リンク</span>
        <span className="km-submenu-arrow">▶</span>
        <div className="km-context-submenu">
          <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onEditLink(); }}>
            リンクを編集...
          </div>
          {node.data.hyperlink && (
            <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onDeleteLink(); }}>
              リンクを削除
            </div>
          )}
        </div>
      </div>

      {/* Image */}
      <div className="km-context-menu-item km-has-submenu">
        <span>画像</span>
        <span className="km-submenu-arrow">▶</span>
        <div className="km-context-submenu">
          <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onEditImage(); }}>
            画像を編集...
          </div>
          {node.data.image && (
            <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onDeleteImage(); }}>
              画像を削除
            </div>
          )}
        </div>
      </div>

      {/* Note */}
      <div className="km-context-menu-item km-has-submenu">
        <span>ノート</span>
        <span className="km-submenu-arrow">▶</span>
        <div className="km-context-submenu">
          <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onEditNote(); }}>
            ノートを編集...
          </div>
          {node.data.note && (
            <div className="km-context-menu-item" onMouseDown={(e) => { e.stopPropagation(); onDeleteNote(); }}>
              ノートを削除
            </div>
          )}
        </div>
      </div>

      {/* Delete */}
      {!isRoot && (
        <>
          <div className="km-context-menu-separator" />
          <div className="km-context-menu-item km-context-menu-danger" onMouseDown={(e) => { e.stopPropagation(); onDelete(); }}>
            削除
          </div>
        </>
      )}
    </div>
  );
}

// --- Arrow key navigation ---

function navigateArrow(
  key: string,
  selectedId: string,
  tree: MindmapInternalNode,
  layout: LayoutDirection,
  setSelected: (id: string) => void,
) {
  const parentResult = findParent(tree, selectedId);
  const current = findNode(tree, selectedId);
  if (!current) return;

  const isHorizontal = layout !== "bottom";

  // Map arrow keys to tree directions based on layout
  let action: "parent" | "child" | "prevSibling" | "nextSibling" | null = null;

  if (isHorizontal) {
    if (key === "ArrowLeft") action = "parent";
    if (key === "ArrowRight") action = "child";
    if (key === "ArrowUp") action = "prevSibling";
    if (key === "ArrowDown") action = "nextSibling";
  } else {
    if (key === "ArrowUp") action = "parent";
    if (key === "ArrowDown") action = "child";
    if (key === "ArrowLeft") action = "prevSibling";
    if (key === "ArrowRight") action = "nextSibling";
  }

  if (action === "parent" && parentResult) {
    setSelected(parentResult.parent.id);
  } else if (action === "child" && current.children.length > 0) {
    setSelected(current.children[0].id);
  } else if (action === "prevSibling" && parentResult) {
    const { parent, index } = parentResult;
    if (index > 0) setSelected(parent.children[index - 1].id);
  } else if (action === "nextSibling" && parentResult) {
    const { parent, index } = parentResult;
    if (index < parent.children.length - 1) setSelected(parent.children[index + 1].id);
  }
}

// --- Wrapper with ReactFlowProvider ---

const MindmapEditor = forwardRef<MindmapEditorHandle, Props>((props, ref) => {
  return (
    <ReactFlowProvider>
      <MindmapEditorInner {...props} editorRef={ref} />
    </ReactFlowProvider>
  );
});

export default MindmapEditor;
