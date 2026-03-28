import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/stores/tab-store";

interface UseKeyboardShortcutsParams {
  handleSave: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleCopyRichText: () => void;
  handleInsertFormatting: (format: string) => void;
  activeViewTab: string;
  openNewTab: () => void;
  closeTab: (tabId: string) => void;
  setShowSearch: React.Dispatch<React.SetStateAction<boolean>>;
  setEditorVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setFolderPanelVisible: React.Dispatch<React.SetStateAction<boolean>>;
  folderPanelTab: "terminal" | "rag";
  setFolderPanelTab: React.Dispatch<React.SetStateAction<"terminal" | "rag">>;
  tabsRef: React.MutableRefObject<Tab[]>;
  activeTabIdRef: React.MutableRefObject<string>;
}

export function useKeyboardShortcuts({
  handleSave,
  handleUndo,
  handleRedo,
  handleCopyRichText,
  handleInsertFormatting,
  activeViewTab,
  openNewTab,
  closeTab,
  setShowSearch,
  setEditorVisible,
  setFolderPanelVisible,
  folderPanelTab,
  setFolderPanelTab,
  tabsRef,
  activeTabIdRef,
}: UseKeyboardShortcutsParams) {
  const { t } = useTranslation();
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        handleSave();
      } else if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        handleUndo();
      } else if (e.ctrlKey && e.key === "y") {
        e.preventDefault();
        handleRedo();
      } else if (e.ctrlKey && (e.key === "f" || e.key === "h")) {
        e.preventDefault();
        setShowSearch((s) => !s);
      } else if (e.ctrlKey && e.shiftKey && e.key === "C") {
        e.preventDefault();
        handleCopyRichText();
      } else if (e.ctrlKey && e.key === "b" && activeViewTab === "preview") {
        e.preventDefault();
        handleInsertFormatting("bold");
      } else if (e.ctrlKey && e.key === "i" && activeViewTab === "preview") {
        e.preventDefault();
        handleInsertFormatting("italic");
      } else if (e.ctrlKey && e.key === "\\") {
        e.preventDefault();
        setEditorVisible((v) => !v);
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setFolderPanelVisible((v) => {
          if (v && folderPanelTab === "terminal") return false;
          setFolderPanelTab("terminal");
          return true;
        });
      } else if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        setFolderPanelVisible((v) => {
          if (v && folderPanelTab === "rag") return false;
          setFolderPanelTab("rag");
          return true;
        });
      } else if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        openNewTab();
      } else if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
        if (tab?.dirty) {
          const name = tab.filePath ? tab.filePath.split(/[\\/]/).pop() ?? "Untitled" : t("untitled");
          if (!window.confirm(t("closeUnsavedConfirm", { name }))) return;
        }
        closeTab(activeTabIdRef.current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleSave,
    handleUndo,
    handleRedo,
    handleCopyRichText,
    handleInsertFormatting,
    activeViewTab,
    openNewTab,
    closeTab,
    setShowSearch,
    setEditorVisible,
    setFolderPanelVisible,
    folderPanelTab,
    setFolderPanelTab,
    tabsRef,
    activeTabIdRef,
    t,
  ]);
}
