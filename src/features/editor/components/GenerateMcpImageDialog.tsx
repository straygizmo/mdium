import { type FC, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { mkdir, copyFile } from "@tauri-apps/plugin-fs";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import type { OpencodeMcpServer } from "@/shared/types";
import "./GenerateImageDialog.css";

interface Props {
  visible: boolean;
  onClose: () => void;
  onInsert: (markdownImage: string) => void;
}

interface McpToolInfo {
  name: string;
  description: string;
}

interface McpTestResult {
  success: boolean;
  tools: McpToolInfo[];
  error: string | null;
}

interface McpCallToolResult {
  content: { type: string; text: string }[];
}

interface AvailableServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout?: number;
}

function makeDefaultFilename(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `img_${ts}.png`;
}

function normalizeCommand(server: OpencodeMcpServer): string[] {
  const cmd = server.command;
  if (Array.isArray(cmd)) return cmd;
  if (typeof cmd === "string") {
    const args = Array.isArray(server.args) ? server.args : [];
    return [cmd, ...args];
  }
  return [];
}

export const GenerateMcpImageDialog: FC<Props> = ({ visible, onClose, onInsert }) => {
  const { t } = useTranslation("editor");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const loadConfig = useOpencodeConfigStore((s) => s.loadConfig);

  const [prompt, setPrompt] = useState("");
  const [filename, setFilename] = useState("");
  const [selectedServer, setSelectedServer] = useState("");
  const [availableServers, setAvailableServers] = useState<AvailableServer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [generatedPath, setGeneratedPath] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  const scanServers = useCallback(async () => {
    // Ensure config is loaded (it's only loaded on-demand when settings page opens)
    await loadConfig();
    const freshConfig = useOpencodeConfigStore.getState();
    const allServers: Record<string, OpencodeMcpServer> = {
      ...(freshConfig.config.mcp ?? {}),
      ...(freshConfig.projectMcpServers ?? {}),
    };

    const entries = Object.entries(allServers).filter(
      ([, s]) => s.enabled !== false && (s.type ?? "local") === "local"
    );

    if (entries.length === 0) {
      setAvailableServers([]);
      return;
    }

    setScanning(true);
    const found: AvailableServer[] = [];

    for (const [name, server] of entries) {
      try {
        const cmdArr = normalizeCommand(server);
        if (cmdArr.length === 0) continue;
        const result = await invoke<McpTestResult>("mcp_test_server", {
          serverType: "local",
          command: cmdArr[0],
          args: cmdArr.length > 1 ? cmdArr.slice(1) : null,
          env: server.environment ?? null,
          url: null,
          headers: null,
        });
        if (result.success && result.tools.some((t) => t.name === "generate_image")) {
          found.push({
            name,
            command: cmdArr[0],
            args: cmdArr.slice(1),
            env: server.environment ?? {},
            timeout: server.timeout,
          });
        }
      } catch {
        // skip servers that fail
      }
    }

    setAvailableServers(found);
    if (found.length > 0 && !selectedServer) {
      setSelectedServer(found[0].name);
    }
    setScanning(false);
  }, [loadConfig, selectedServer]);

  useEffect(() => {
    if (visible) {
      scanServers();
      setFilename((prev) => (prev.trim() === "" ? makeDefaultFilename() : prev));
    }
  }, [visible, scanServers]);

  if (!visible) return null;

  const handleGenerate = async () => {
    if (!prompt.trim() || !filename.trim() || !selectedServer) return;
    setGenerating(true);
    setError("");
    setGeneratedPath("");

    try {
      const server = availableServers.find((s) => s.name === selectedServer);
      if (!server) {
        setError("Server not found");
        return;
      }

      const outputDir = activeFolderPath
        ? `${activeFolderPath.replace(/\\/g, "/")}/images`
        : "";
      if (!outputDir) {
        setError("No folder is open");
        return;
      }

      const result = await invoke<McpCallToolResult>("mcp_call_tool", {
        command: server.command,
        args: server.args,
        env: { ...server.env, IMAGE_OUTPUT_DIR: outputDir },
        toolName: "generate_image",
        toolArgs: {
          prompt: prompt.trim(),
          filename: filename.trim(),
        },
        timeoutMs: server.timeout ?? null,
      });

      const textContent = result.content.find((c) => c.type === "text");
      if (!textContent) {
        setError("No text content in tool response");
        return;
      }

      // MCP generate_image returns JSON with path info
      const parsed = JSON.parse(textContent.text);

      if (!parsed.path && parsed.absolutePath) {
        // External MCP server — copy image to images folder
        const safeName = filename.trim().replace(/[\\/:*?"<>|]/g, "_");
        const destPath = `${outputDir}/${safeName}`;
        await mkdir(outputDir, { recursive: true });
        await copyFile(parsed.absolutePath, destPath);
        setGeneratedPath(`images/${safeName}`);

        // Load preview from source path
        try {
          const bytes = await invoke<number[]>("read_binary_file", { path: parsed.absolutePath });
          const mime = parsed.mimeType || "image/png";
          const blob = new Blob([new Uint8Array(bytes)], { type: mime });
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          setPreviewUrl(URL.createObjectURL(blob));
        } catch {
          // Preview failed silently
        }
      } else if (parsed.path) {
        setGeneratedPath(parsed.path);

        // Load preview
        if (parsed.absolutePath) {
          try {
            const bytes = await invoke<number[]>("read_binary_file", { path: parsed.absolutePath });
            const mime = parsed.mimeType || "image/png";
            const blob = new Blob([new Uint8Array(bytes)], { type: mime });
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            setPreviewUrl(URL.createObjectURL(blob));
          } catch {
            // Preview failed silently
          }
        }
      } else {
        setError(textContent.text);
        return;
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleInsert = () => {
    const path = generatedPath || `/images/${filename}`;
    onInsert(`![${prompt}](${path})`);
    handleReset();
  };

  const handleReset = () => {
    setPrompt("");
    setFilename("");
    setSelectedServer(availableServers.length > 0 ? availableServers[0].name : "");
    setError("");
    setGeneratedPath("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    setGenerating(false);
    onClose();
  };

  return (
    <div className="gen-image-dialog-overlay" onClick={handleReset}>
      <div className="gen-image-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="gen-image-dialog__title">{t("genMcpImageTitle")}</h3>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genMcpImageServer")}</label>
          {scanning ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>{t("genMcpImageScanning")}</div>
          ) : availableServers.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{t("genMcpImageNoServers")}</div>
          ) : (
            <select
              className="gen-image-dialog__select"
              value={selectedServer}
              onChange={(e) => setSelectedServer(e.target.value)}
              disabled={generating}
            >
              {availableServers.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          )}
        </div>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImagePrompt")}</label>
          <textarea
            className="gen-image-dialog__textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("genImagePromptPlaceholder")}
            disabled={generating}
          />
        </div>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImageFilename")}</label>
          <input
            className="gen-image-dialog__input"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="architecture-diagram.png"
            disabled={generating}
          />
        </div>

        {error && <div className="gen-image-dialog__error">{error}</div>}

        {generatedPath ? (
          <div style={{ marginTop: 12 }}>
            {previewUrl && (
              <img className="gen-image-dialog__preview" src={previewUrl} alt={prompt} />
            )}
            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{t("genImageGenerated")}: {generatedPath}</p>
            <div className="gen-image-dialog__actions">
              <button className="gen-image-dialog__btn gen-image-dialog__btn--primary" onClick={handleInsert}>
                {t("genImageInsert")}
              </button>
              <button className="gen-image-dialog__btn" onClick={handleGenerate} disabled={generating}>
                {t("genImageRegenerate")}
              </button>
              <button className="gen-image-dialog__btn" onClick={handleReset}>
                {t("cancel", { ns: "common" })}
              </button>
            </div>
          </div>
        ) : (
          <div className="gen-image-dialog__actions">
            <button
              className="gen-image-dialog__btn gen-image-dialog__btn--primary"
              onClick={handleGenerate}
              disabled={generating || !prompt.trim() || !filename.trim() || !selectedServer || scanning}
            >
              {generating ? t("genImageGenerating") : t("genImageGenerate")}
            </button>
            <button className="gen-image-dialog__btn" onClick={handleReset}>
              {t("cancel", { ns: "common" })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
