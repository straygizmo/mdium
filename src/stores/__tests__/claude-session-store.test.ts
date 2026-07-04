// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { useClaudeSessionStore, DEFAULT_CLAUDE_FOLDER_SETTINGS } from "../claude-session-store";

describe("claude-session-store", () => {
  beforeEach(() => {
    useClaudeSessionStore.setState({ folders: {} });
  });

  it("returns defaults for an unknown folder", () => {
    const s = useClaudeSessionStore.getState().getFolderSettings("C:/proj");
    expect(s).toEqual(DEFAULT_CLAUDE_FOLDER_SETTINGS);
  });

  it("persists per-folder session id, model and permission mode independently", () => {
    const st = useClaudeSessionStore.getState();
    st.setLastSessionId("C:/a", "sess-1");
    st.setModel("C:/a", "claude-sonnet-5");
    st.setPermissionMode("C:/b", "acceptEdits");

    const a = useClaudeSessionStore.getState().getFolderSettings("C:/a");
    const b = useClaudeSessionStore.getState().getFolderSettings("C:/b");
    expect(a).toMatchObject({ lastSessionId: "sess-1", model: "claude-sonnet-5" });
    expect(a.permissionMode).toBe("default");
    expect(b).toMatchObject({ lastSessionId: null, permissionMode: "acceptEdits" });
  });
});
