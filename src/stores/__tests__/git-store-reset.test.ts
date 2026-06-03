import { describe, it, expect, beforeEach, vi } from "vitest";

// The git store imports tauri's invoke and the opencode chat module at load
// time. Stub both so the store can be exercised in a plain node test env
// without a real backend.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve("")),
}));
vi.mock("@/features/opencode-config/hooks/useOpencodeChat", () => ({
  getOpencodeClient: () => null,
  useChatUIStore: { getState: () => ({ connected: false }) },
}));

import { useGitStore } from "../git-store";

describe("git-store reset", () => {
  beforeEach(() => {
    // Simulate a folder that had uncommitted changes loaded.
    useGitStore.setState({
      files: [
        { path: "a.md", staged: false, status: "M", indexStatus: " ", workStatus: "M" } as any,
        { path: "b.md", staged: true, status: "A", indexStatus: "A", workStatus: " " } as any,
      ],
      currentBranch: "main",
      branches: ["main"],
      isRepo: true,
      remoteUrl: "https://example.com/repo.git",
      commitsAhead: 2,
    });
  });

  it("clears the file list so the git badge count drops to zero", () => {
    expect(useGitStore.getState().files.length).toBe(2);

    useGitStore.getState().reset();

    expect(useGitStore.getState().files.length).toBe(0);
    expect(useGitStore.getState().isRepo).toBe(false);
    expect(useGitStore.getState().currentBranch).toBe("");
    expect(useGitStore.getState().commitsAhead).toBe(0);
  });
});
