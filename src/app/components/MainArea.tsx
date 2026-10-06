import { useEffect, useRef, type ReactNode } from "react";
import { useUiStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import { Workspace } from "@/features/workflow/components/Workspace";
import { FlowWorkspace } from "@/features/flow/components/FlowWorkspace";
import { useSettingsStore } from "@/stores/settings-store";

interface MainAreaProps {
  /** The editor/tab content of the main area. */
  children: ReactNode;
}

/**
 * Switches the main area between the editor content and a workspace: the
 * workflow workspace while the workflows panel is selected, or the flow
 * workspace while the (experimental) flows panel is selected. A workspace is
 * shown only while a folder is open (otherwise the welcome screen stays). The
 * editor content stays mounted (only hidden) while a workspace is shown, so
 * switching back keeps every editor's state.
 */
export function MainArea({ children }: MainAreaProps) {
  const workflowPanel = useUiStore((s) => s.leftPanel === "workflow");
  const flowPanel = useUiStore((s) => s.leftPanel === "flow");
  const experimentalFlows = useSettingsStore((s) => s.experimentalFlows);
  const hasFolder = useTabStore((s) => !!s.activeFolderPath);
  const showFlowWorkspace = flowPanel && experimentalFlows && hasFolder;
  const showWorkspace = (workflowPanel && hasFolder) || showFlowWorkspace;
  const wasShowingWorkspace = useRef(showWorkspace);

  useEffect(() => {
    if (wasShowingWorkspace.current && !showWorkspace) {
      // Content that lays out on window resize (rather than observing its own
      // size) was measured at zero size while hidden; let it relayout.
      window.dispatchEvent(new Event("resize"));
    }
    wasShowingWorkspace.current = showWorkspace;
  }, [showWorkspace]);

  return (
    <>
      <div className="app__main-content" style={{ display: showWorkspace ? "none" : "contents" }}>
        {children}
      </div>
      {showWorkspace && (showFlowWorkspace ? <FlowWorkspace /> : <Workspace />)}
    </>
  );
}
