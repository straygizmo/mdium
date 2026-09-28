import type { IntakeSessionView } from "@/shared/types/workflow";

/** A complete active session with a proposal; `patch` overrides fields. */
export function reviewSession(patch: Partial<IntakeSessionView> = {}): IntakeSessionView {
  return {
    schemaVersion: 1,
    id: "i1",
    workflowId: "wf1",
    kind: "feature",
    provider: "claude",
    model: null,
    status: "active",
    messages: [],
    lastQuestion: null,
    proposal: { title: "Export CSV", body: "Users can **export** data." },
    docUpdates: [],
    finalize: {
      stage: "ready",
      rootTaskId: null,
      issue: null,
      attachmentIds: [],
      skipIssue: false,
      issueCreating: false,
      lastError: null,
    },
    createdAt: "",
    updatedAt: "u1",
    busy: false,
    finalizeRunning: false,
    appliedDocPaths: [],
    ...patch,
  };
}
