// Shared contract for the RAG HTTP bridge. Keep this file free of webview-only
// imports: sidecar code imports it too.
export type RagBridgeKind = "search" | "status" | "convert" | "update";
export type RagApproval = "ask" | "auto";
export interface RagBridgeRequest {
  id: string;
  kind: RagBridgeKind;
  folderPath: string;
  query?: string | null;
  limit?: number | null;
  searchMode?: string | null;
  bm25Weight?: number | null;
  paths?: string[];
  approval?: RagApproval;
}
export type RagIndexState = "empty" | "ready" | "updating" | "converting" | "error";
export type RagJobKind = "convert" | "update";
export interface RagJobInfo {
  id: string;
  kind: RagJobKind;
  folder: string;
  state: "running" | "done" | "failed";
  done: number;
  total: number;
  current_file: string;
  errors: { path: string; message: string }[];
}
export interface RagUnconvertedDoc {
  path: string;
  type: "docx" | "xlsx" | "pptx" | "pdf";
}
export interface RagStatusPayload {
  ok: true;
  state: RagIndexState;
  total_chunks: number;
  total_files: number;
  embedding_model: string;
  progress: { phase: string; current: number; total: number } | null;
  unconverted_office_docs: RagUnconvertedDoc[];
  job: RagJobInfo | null;
  error: string | null;
}
export type RagRejectReason = "exists" | "unsupported" | "outside_folder" | "not_found";
export interface RagConvertAccepted {
  ok: true;
  job_id: string;
  accepted: string[];
  rejected: { path: string; reason: RagRejectReason }[];
}
export interface RagUpdateAccepted {
  ok: true;
  job_id: string;
}
export type RagBridgeErrorCode =
  | "job_running"
  | "no_folder"
  | "approval_denied"
  | "approval_timeout"
  | "invalid_request"
  | "nothing_to_convert"
  | "internal";
export interface RagBridgeError {
  ok: false;
  error: RagBridgeErrorCode;
  message?: string;
}
// Shared by the webview and the sidecars.
export interface StdioMcpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}
