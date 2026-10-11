import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ArtifactLocation, ArtifactRef } from "@/shared/types/flow-run";
import { registerDefaultTransport, type FlowEventName, type FlowTransport } from "./transport";

/** The desktop transport: Tauri commands and events. */
export function createTauriTransport(): FlowTransport {
  return {
    call: <T,>(command: string, args: Record<string, unknown>) => invoke<T>(command, args),
    subscribe: async <T,>(event: FlowEventName, handler: (payload: T) => void) =>
      listen<T>(event, (e) => handler(e.payload)),
    artifactUrl: async (projectRoot: string, ref: ArtifactRef) => {
      const location = await invoke<ArtifactLocation>("flow_artifact_path", { projectRoot, ...ref });
      return convertFileSrc(location.path, "asset");
    },
  };
}

registerDefaultTransport(createTauriTransport);
