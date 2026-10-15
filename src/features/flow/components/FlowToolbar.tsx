import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface FlowToolbarProps {
  /** False for a read-only file: every edit action is disabled. */
  editable: boolean;
  /** False while there is no decoded flow to add nodes to. */
  canAddNode: boolean;
  yamlOpen: boolean;
  validating: boolean;
  saving: boolean;
  /** Number of selected nodes; extraction needs at least one. */
  selectedCount: number;
  /** Renders the node palette; `close` hides it again. */
  renderPalette(close: () => void): ReactNode;
  onSave(): void;
  onValidate(): void;
  onToggleYaml(): void;
  onExtract(): void;
}

/** Editor actions above the canvas: add node (palette), save, YAML view, validate. */
export function FlowToolbar({
  editable,
  canAddNode,
  yamlOpen,
  validating,
  saving,
  selectedCount,
  renderPalette,
  onSave,
  onValidate,
  onToggleYaml,
  onExtract,
}: FlowToolbarProps) {
  const { t } = useTranslation("flow");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteHost = useRef<HTMLDivElement>(null);
  const addEnabled = editable && canAddNode;

  useEffect(() => {
    if (!addEnabled) setPaletteOpen(false);
  }, [addEnabled]);

  // The palette has no dismiss handling of its own: close it on Escape and on a press outside.
  useEffect(() => {
    if (!paletteOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPaletteOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (paletteHost.current && e.target instanceof Node && !paletteHost.current.contains(e.target)) {
        setPaletteOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [paletteOpen]);

  return (
    <div className="flow-toolbar" role="toolbar">
      <div className="flow-toolbar__palette-host" ref={paletteHost}>
        <button
          type="button"
          className={`flow-toolbar__button${paletteOpen ? " flow-toolbar__button--active" : ""}`}
          disabled={!addEnabled}
          aria-expanded={paletteOpen}
          onClick={() => setPaletteOpen((open) => !open)}
        >
          {t("editor.addNode")}
        </button>
        {paletteOpen && <div className="flow-toolbar__palette">{renderPalette(() => setPaletteOpen(false))}</div>}
      </div>
      <button type="button" className="flow-toolbar__button" disabled={!editable || saving} onClick={onSave}>
        {t("editor.save")}
      </button>
      <button type="button" className="flow-toolbar__button" disabled={!editable} onClick={onValidate}>
        {t("editor.validate")}
      </button>
      <button type="button" className="flow-toolbar__button" disabled={!addEnabled || selectedCount < 1} onClick={onExtract}>
        {t("editor.extract")}
      </button>
      <button
        type="button"
        className={`flow-toolbar__button${yamlOpen ? " flow-toolbar__button--active" : ""}`}
        aria-pressed={yamlOpen}
        onClick={onToggleYaml}
      >
        {t("editor.yaml")}
      </button>
      {validating && <span className="flow-toolbar__status">{t("editor.validating")}</span>}
    </div>
  );
}
