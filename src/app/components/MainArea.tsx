import type { ReactNode } from "react";
import { useUiStore } from "@/stores/ui-store";
import { Workspace } from "@/features/workflow/components/Workspace";

interface MainAreaProps {
  /** The editor/tab content of the main area. */
  children: ReactNode;
}

/**
 * Switches the main area between the editor content and the workflow
 * workspace. The editor content stays mounted (only hidden) while the
 * workspace is shown, so switching back keeps every editor's state.
 */
export function MainArea({ children }: MainAreaProps) {
  const showWorkspace = useUiStore((s) => s.leftPanel === "workflow");
  return (
    <>
      <div className="app__main-content" style={{ display: showWorkspace ? "none" : "contents" }}>
        {children}
      </div>
      {showWorkspace && <Workspace />}
    </>
  );
}
