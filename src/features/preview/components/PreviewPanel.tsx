import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showConfirm } from "@/stores/dialog-store";
import { getThemeById } from "@/shared/themes";
import { makeHeadingId } from "@/shared/lib/markdown/heading-id";
import {
  renderMarkdownWithSourceLines,
  splitFrontMatter,
} from "@/shared/lib/markdown/render-with-source-lines";

import { usePreviewTableEdit } from "../hooks/usePreviewTableEdit";
import { OfficePreview } from "./OfficePreview";
import { PdfPreviewPanel } from "./PdfPreviewPanel";
import { DocxPreviewPanel } from "./DocxPreviewPanel";
import { HtmlPreviewPanel } from "./HtmlPreviewPanel";
import { SlidevPreviewPanel } from "./SlidevPreviewPanel";
import { CsvPreviewPanel } from "./CsvPreviewPanel";
import { ZennFrontmatterForm } from "@/features/zenn/components/ZennFrontmatterForm";
import { VideoPanel } from "@/features/video/components/VideoPanel";
import { VideoScenarioDialog, type VideoScenarioParams } from "@/features/video/components/VideoScenarioDialog";
import { useVideoStore } from "@/stores/video-store";
import { DEFAULT_META, DEFAULT_TTS_CONFIG, DEFAULT_TRANSITION, type NarrationSegment } from "@/features/video/types";
import { splitNarration } from "@/features/video/lib/narration-splitter";
import { videoFilePrefix } from "@/features/video/lib/audio-filename";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useChatUIStore, consumePendingVideoOutput, doConnect, doCreateNewSession, doSendMessage, setPendingVideoOutput, syncMdiumVbaMcpConfig } from "@/features/opencode-config/hooks/useOpencodeChat";
import { BUILTIN_COMMANDS } from "@/features/opencode-config/lib/builtin-commands";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { docxToMarkdown } from "@/features/export/lib/docxToMarkdown";
import { marked } from "marked";
import { MediumPublishDialog } from "@/features/medium/components/MediumPublishDialog";
import type { MediumPublishParams } from "@/features/medium/components/MediumPublishDialog";
import { readFile } from "@tauri-apps/plugin-fs";
import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";
import mermaid from "mermaid";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./PreviewPanel.css";

// Initialize mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  flowchart: { htmlLabels: false },
  sequence: { useMaxWidth: false },
});

let mermaidCounter = 0;

// Configure marked
marked.use({
  async: false,
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string | null }) {
      if (lang === "mermaid") {
        const id = `mermaid-placeholder-${mermaidCounter++}`;
        const escaped = text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<div class="mermaid-placeholder" data-mermaid-id="${id}" data-mermaid-source="${encodeURIComponent(text)}"><pre class="mermaid-source-fallback"><code>${escaped}</code></pre></div>`;
      }
      if (lang === "math") {
        try {
          return `<div class="math-block-display">${katex.renderToString(text, { displayMode: true, throwOnError: false })}</div>`;
        } catch {
          return `<pre><code>${text}</code></pre>`;
        }
      }
      const language = lang || "plaintext";
      try {
        const highlighted = hljs.highlight(text, {
          language,
          ignoreIllegals: true,
        });
        return `<pre><code class="hljs language-${language}">${highlighted.value}</code></pre>`;
      } catch {
        const escaped = text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<pre><code>${escaped}</code></pre>`;
      }
    },
    heading({ text, depth }: { text: string; depth: number }) {
      const id = makeHeadingId(text);
      return `<h${depth} id="${id}">${text}</h${depth}>`;
    },
    image({ href, title, text }: { href: string; title?: string | null; text: string }) {
      // Zenn: ![alt](url =250x) → width specification
      const sizeMatch = href.match(/^(.+?)\s+=(\d*)x(\d*)$/);
      if (sizeMatch) {
        const [, url, w, h] = sizeMatch;
        const attrs = [
          `src="${url}"`,
          `alt="${text}"`,
          w ? `width="${w}"` : "",
          h ? `height="${h}"` : "",
          title ? `title="${title}"` : "",
        ].filter(Boolean).join(" ");
        return `<img ${attrs} />`;
      }
      return `<img src="${href}" alt="${text}"${title ? ` title="${title}"` : ""} />`;
    },
  },
});

/**
 * Extract YAML front matter and separate it from the body
 */
function extractFrontMatter(content: string): {
  meta: Record<string, string> | null;
  body: string;
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { meta: null, body: content };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { meta: null, body: content };

  const yaml = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, string> = {};

  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) meta[key] = value;
    }
  }
  return { meta: Object.keys(meta).length > 0 ? meta : null, body };
}

const SLIDEV_FRONTMATTER_KEYS = ["theme", "class", "drawings", "highlighter", "lineNumbers", "colorSchema"];

function isSlidevMarkdown(content: string): boolean {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    if (SLIDEV_FRONTMATTER_KEYS.some((key) => new RegExp(`^${key}:`, "m").test(fm))) {
      return true;
    }
  }
  const withoutFm = content.replace(/^---\s*\n[\s\S]*?\n---/, "");
  const separators = withoutFm.match(/^\s*---\s*$/gm);
  return (separators?.length ?? 0) >= 2;
}

/**
 * Restore narrationSegments from audio files on disk for scenes that lost them
 * (e.g. due to stale tab content overwriting the project).
 */
async function restoreNarrationSegments(
  project: { scenes: any[] },
  mdPath: string,
): Promise<void> {
  const mdDir = mdPath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  const prefix = videoFilePrefix(mdPath);
  const updateScene = useVideoStore.getState().updateScene;

  for (let i = 0; i < project.scenes.length; i++) {
    const scene = project.scenes[i];
    if (scene.narrationSegments?.length) continue;
    if (!scene.narration?.trim()) continue;

    const texts = splitNarration(scene.narration);
    const sceneNum = String(i + 1).padStart(2, "0");
    const segments: NarrationSegment[] = [];
    let hasAny = false;

    for (let j = 0; j < texts.length; j++) {
      const segNum = String(j + 1).padStart(2, "0");
      const audioPath = `${mdDir}/audio/${prefix}_scene_${sceneNum}_${segNum}.wav`;
      const exists = await invoke<boolean>("video_file_exists", { path: audioPath }).catch(() => false);
      segments.push({ text: texts[j], audioPath: exists ? audioPath : undefined });
      if (exists) hasAny = true;
    }

    if (hasAny) {
      updateScene(scene.id, {
        narrationSegments: segments,
        narrationAudio: segments.find((s) => s.audioPath)?.audioPath,
        narrationDirty: false,
      });
    }
  }

  // Recalculate audioGenerated after restoration
  const { videoProject: updated } = useVideoStore.getState();
  if (updated) {
    const allReady = updated.scenes.every((sc) => {
      if (sc.narrationDirty) return false;
      if (sc.narrationSegments?.length) {
        return sc.narrationSegments.every((seg: NarrationSegment) => seg.audioPath);
      }
      return false;
    });
    if (allReady) {
      useVideoStore.getState().setAudioGenerated(true);
    }
  }
}

interface PreviewPanelProps {
  previewRef: React.RefObject<HTMLDivElement | null>;
  onOpenFile?: (path: string) => void;
  onRefreshFileTree?: () => void;
}

export function PreviewPanel({ previewRef, onOpenFile, onRefreshFileTree }: PreviewPanelProps) {
  const { t } = useTranslation("editor");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const themeId = useSettingsStore((s) => s.themeId);
  const themeType = getThemeById(themeId).type;
  const activeViewTab = useUiStore((s) => s.activeViewTab);
  const setActiveViewTab = useUiStore((s) => s.setActiveViewTab);
  const isZennMode = useUiStore((s) => s.isZennMode);
  const contentRef = useRef<HTMLDivElement>(null);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [macroExporting, setMacroExporting] = useState(false);
  const [macroImporting, setMacroImporting] = useState(false);
  const allowLlmVbaImport = useSettingsStore((s) => s.allowLlmVbaImport);
  const setAllowLlmVbaImport = useSettingsStore((s) => s.setAllowLlmVbaImport);
  const [macroError, setMacroError] = useState<string | null>(null);
  const [macroSuccess, setMacroSuccess] = useState<string | null>(null);
  const [macrosDirExists, setMacrosDirExists] = useState(false);
  const [scenarioDialog, setScenarioDialog] = useState<{ videoJsonName: string; mdPath: string; baseName: string; hasExisting: boolean; commandName: string } | null>(null);
  const [mediumDialog, setMediumDialog] = useState<{
    title: string;
    tags: string[];
    canonicalUrl: string;
    body: string;
    filePath: string;
  } | null>(null);

  const content = activeTab?.content ?? "";
  const filePath = activeTab?.filePath ?? null;
  // Hooks run before the component's early-return branches, so any effect or
  // memo that processes `content` would otherwise fire for CSV / binary tabs
  // too — feeding a 50MB CSV into marked or regex scans freezes the UI.
  const isRenderableMarkdown = !!activeTab
    && !activeTab.csvFileType
    && !activeTab.officeFileType
    && !activeTab.mindmapFileType
    && !activeTab.imageFileType
    && !activeTab.binaryData;
  const isSlidev = useMemo(
    () => (isRenderableMarkdown ? isSlidevMarkdown(content) : false),
    [content, isRenderableMarkdown],
  );

  const setIsVideoMode = useVideoStore((s) => s.setIsVideoMode);
  const setVideoProject = useVideoStore((s) => s.setVideoProject);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const configCommands = useOpencodeConfigStore((s) => s.config.command);
  const globalCommands = useMemo(() => configCommands ?? {}, [configCommands]);

  const handleEnterVideoMode = useCallback(async (commandName = "generate-video-scenario") => {
    if (!filePath) return;

    // Derive paths
    const lastDot = filePath.lastIndexOf(".");
    const basePath = lastDot > 0 ? filePath.slice(0, lastDot) : filePath;
    const baseName = basePath.split(/[/\\]/).pop() ?? basePath;
    const videoJsonName = baseName + ".video.json";

    // Check if .video.json already exists
    const existing = await invoke<string | null>("video_load_project", { mdPath: filePath });

    setScenarioDialog({ videoJsonName, mdPath: filePath, baseName, hasExisting: !!existing, commandName });
  }, [filePath]);

  const handlePublishToMedium = useCallback(() => {
    if (!filePath) return;

    const token = useSettingsStore.getState().mediumSettings.apiToken;
    if (!token) {
      alert(t("mediumTokenNotSet"));
      return;
    }

    const raw = activeTab?.content ?? "";
    const { meta, body } = extractFrontMatter(raw);

    // Parse title: frontmatter > first h1 > filename
    let title = meta?.["medium_title"] ?? "";
    if (!title) {
      const h1Match = body.match(/^#\s+(.+)$/m);
      title = h1Match ? h1Match[1] : filePath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? "";
    }

    // Parse tags (frontmatter value is a string like "[\"tag1\", \"tag2\"]")
    let tags: string[] = [];
    const tagsRaw = meta?.["medium_tags"] ?? "";
    if (tagsRaw) {
      try {
        const parsed = JSON.parse(tagsRaw);
        if (Array.isArray(parsed)) tags = parsed.slice(0, 5);
      } catch {
        // Try comma-separated fallback
        tags = tagsRaw
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
          .slice(0, 5);
      }
    }

    const canonicalUrl = meta?.["medium_canonical_url"] ?? "";

    setMediumDialog({ title, tags, canonicalUrl, body, filePath });
  }, [filePath, activeTab?.content, t]);

  const handleMediumSubmit = useCallback(
    async (params: MediumPublishParams) => {
      if (!mediumDialog) return;
      const { body, filePath: mdFilePath } = mediumDialog;
      setMediumDialog(null);

      const token = useSettingsStore.getState().mediumSettings.apiToken;

      try {
        // Convert Markdown to HTML
        let html = marked(body) as string;

        // Extract local image paths and upload them
        const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
        const localImages: { original: string; absPath: string }[] = [];
        let match: RegExpExecArray | null;

        while ((match = imgRegex.exec(html)) !== null) {
          const src = match[1];
          // Skip already-hosted URLs
          if (/^https?:\/\//i.test(src)) continue;

          // Resolve relative path against the file's directory
          const fileDir = mdFilePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
          const absPath = src.startsWith("/") || /^[a-zA-Z]:/.test(src)
            ? src
            : `${fileDir}/${src}`;
          localImages.push({ original: src, absPath });
        }

        // Upload images sequentially
        for (let i = 0; i < localImages.length; i++) {
          const img = localImages[i];
          const result = await invoke<string>("medium_upload_image", {
            token,
            filePath: img.absPath,
          });
          const parsed = JSON.parse(result);
          if (parsed.url) {
            html = html.split(img.original).join(parsed.url);
          }
        }

        // Create the post
        const result = await invoke<string>("medium_create_post", {
          req: {
            token,
            title: params.title,
            content: html,
            tags: params.tags,
            canonicalUrl: params.canonicalUrl,
          },
        });

        const post = JSON.parse(result);
        alert(`${t("mediumPublishSuccess")}\n${post.url}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`${t("mediumPublishFailed")}: ${msg}`);
      }
    },
    [mediumDialog, t],
  );

  const handleCommandSelect = useCallback(async (commandName: string) => {
    if (!filePath) return;

    if (commandName.startsWith("generate-video-scenario")) {
      handleEnterVideoMode(commandName);
      return;
    }

    if (commandName === "publish-to-medium") {
      handlePublishToMedium();
      return;
    }

    const cmd = globalCommands[commandName];
    if (!cmd) return;

    const prompt = cmd.template.replace(/\$ARGUMENTS/g, filePath);

    // Clear agent selection (use Default mode)
    useChatUIStore.setState({ selectedAgent: null });

    // Switch UI to chat panel
    useUiStore.getState().setLeftPanel("opencode-config");
    useTabStore.getState().setFolderLeftPanel("opencode-config");
    useUiStore.getState().setOpencodeTopTab("chat");

    // Ensure connection, create a new chat, and send expanded prompt
    await doConnect(activeFolderPath ?? undefined);
    await doCreateNewSession();
    doSendMessage(prompt);
  }, [filePath, globalCommands, handleEnterVideoMode, handlePublishToMedium, activeFolderPath]);

  // Auto-open .video.json when generate-video-scenario command completes
  const chatLoading = useChatUIStore((s) => s.loading);
  const prevChatLoadingRef = useRef(true);

  useEffect(() => {
    // Detect transition from loading → not loading
    if (prevChatLoadingRef.current && !chatLoading) {
      const outputPath = consumePendingVideoOutput();
      if (outputPath && onOpenFile) {
        // Small delay to ensure file is written to disk
        setTimeout(() => onOpenFile(outputPath), 500);
      }
    }
    prevChatLoadingRef.current = chatLoading;
  }, [chatLoading, onOpenFile]);

  const handleScenarioSubmit = useCallback(async (params: VideoScenarioParams) => {
    if (!scenarioDialog) return;
    const { mdPath, baseName, commandName } = scenarioDialog;
    setScenarioDialog(null);

    // Determine output path
    const lastDot = mdPath.lastIndexOf(".");
    const basePath = lastDot > 0 ? mdPath.slice(0, lastDot) : mdPath;
    const dir = mdPath.substring(0, Math.max(mdPath.lastIndexOf("/"), mdPath.lastIndexOf("\\")) + 1);

    let outputPath: string;
    if (params.overwriteChoice === "overwrite") {
      outputPath = basePath + ".video.json";
    } else {
      const now = new Date();
      const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      outputPath = dir + baseName + "_" + ts + ".video.json";
    }

    // Clear agent selection (use Default mode)
    useChatUIStore.setState({ selectedAgent: null });

    // Switch UI to chat panel
    useUiStore.getState().setLeftPanel("opencode-config");
    useTabStore.getState().setFolderLeftPanel("opencode-config");
    useUiStore.getState().setOpencodeTopTab("chat");

    // Expand the template with actual parameter values (prefer user-edited version)
    const videoCmd = globalCommands[commandName] ?? BUILTIN_COMMANDS[commandName];
    const prompt = videoCmd.template
      .replace(/\$1/g, mdPath)
      .replace(/\$2/g, outputPath)
      .replace(/\$3/g, params.resolution)
      .replace(/\$4/g, params.aspectRatio)
      .replace(/\$5/g, String(params.sceneCount))
      .replace(/\$6/g, String(params.videoLength))
      .replace(/\$7/g, String(params.ttsSpeed));

    // Track output path for auto-open when generation completes
    setPendingVideoOutput(outputPath);

    // Ensure connection, create a new chat, and send expanded prompt
    await doConnect(activeFolderPath ?? undefined);
    await doCreateNewSession();
    doSendMessage(prompt);
  }, [scenarioDialog, activeFolderPath, globalCommands]);

  const handleScenarioCancel = useCallback(() => {
    setScenarioDialog(null);
  }, []);

  // When a .video.json file is opened, load its content as a VideoProject
  const isVideoJson = useMemo(
    () => !!filePath && filePath.toLowerCase().endsWith(".video.json"),
    [filePath],
  );
  useEffect(() => {
    if (!isVideoJson || !content || !filePath) return;
    // Don't re-initialize if the store already has a project for this source file
    // (tab content is stale — the video panel auto-saves to disk but doesn't update
    // the tab, so re-parsing would overwrite live state like captions and audio)
    const mdPath = filePath.replace(/\.video\.json$/i, ".md");
    const { videoProject: existing, sourceFilePath: existingSource } = useVideoStore.getState();
    if (existing && existingSource === mdPath) {
      setIsVideoMode(true);
      return;
    }
    try {
      const parsed = JSON.parse(content);
      // Normalize: ensure meta and audio exist with defaults
      const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
      const project = {
        ...parsed,
        meta: { ...DEFAULT_META, ...parsed.meta },
        audio: { tts: { ...DEFAULT_TTS_CONFIG }, ...parsed.audio },
        scenes: rawScenes.map((s: any) => ({
          ...s,
          narration: s.narration ?? "",
          transition: { ...DEFAULT_TRANSITION, ...s.transition },
          elements: Array.isArray(s.elements) ? s.elements : [],
        })),
      };
      setVideoProject(project, mdPath);
      setIsVideoMode(true);
      // Restore narrationSegments from audio files on disk for scenes that lost them
      restoreNarrationSegments(project, mdPath);
    } catch { /* ignore parse errors */ }
  }, [isVideoJson, content, filePath, setVideoProject, setIsVideoMode]);

  // Force switch away from slidev-preview when file is not Slidev markdown
  useEffect(() => {
    if (activeViewTab === "slidev-preview" && !isSlidev) {
      setActiveViewTab("preview");
    }
  }, [isSlidev, activeViewTab, setActiveViewTab]);

  // Markdown rendered HTML
  const [html, setHtml] = useState("");
  const [frontMatter, setFrontMatter] = useState<Record<string, string> | null>(null);

  // Determine if the current file is a Zenn article (articles/ or work/ directory)
  const isZennArticleFile = useMemo(() => {
    if (!isZennMode || !filePath || !filePath.endsWith(".md")) return false;
    const normalized = filePath.replace(/\\/g, "/");
    return normalized.includes("/work/") || normalized.includes("/articles/");
  }, [isZennMode, filePath]);

  // Parse frontmatter fields into typed values for the Zenn form
  // (extractFrontMatter returns topics as a raw string like ["react", "typescript"])
  const parsedZennFrontmatter = useMemo(() => {
    if (!frontMatter) return null;
    const topicsStr = frontMatter.topics ?? "";
    let topics: string[] = [];
    const match = topicsStr.match(/\[([^\]]*)\]/);
    if (match) {
      topics = match[1]
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    return {
      title: frontMatter.title ?? "",
      emoji: frontMatter.emoji ?? "",
      type: (frontMatter.type === "idea" ? "idea" : "tech") as "tech" | "idea",
      topics,
      published: frontMatter.published === "true",
    };
  }, [frontMatter]);

  // Rebuild YAML frontmatter from form values and update editor content
  const handleZennFrontmatterChange = useCallback(
    (fm: { title: string; emoji: string; type: "tech" | "idea"; topics: string[]; published: boolean }) => {
      const tab = useTabStore.getState().getActiveTab();
      if (!tab) return;
      const { body } = extractFrontMatter(tab.content);
      const escapeYaml = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const topicsStr = fm.topics.map((t) => `"${escapeYaml(t)}"`).join(", ");
      const newFrontmatter = [
        "---",
        `title: "${escapeYaml(fm.title)}"`,
        `emoji: "${escapeYaml(fm.emoji)}"`,
        `type: "${fm.type}"`,
        `topics: [${topicsStr}]`,
        `published: ${fm.published}`,
        "---",
      ].join("\n");
      useTabStore.getState().updateTabContent(tab.id, `${newFrontmatter}\n${body}`);
    },
    []
  );

  // Preview table editing
  const {
    contextMenu,
    setContextMenu,
    addRow,
    deleteRow,
    addColumn,
    deleteColumn,
  } = usePreviewTableEdit(contentRef, content, html);

  const exportTableCsv = useCallback(async (tableIndex: number) => {
    const div = contentRef.current;
    if (!div || !filePath) return;

    try {
      const tables = div.querySelectorAll("table");
      const table = tables[tableIndex];
      if (!table) return;

      // Extract cell data from DOM
      const csvRows: string[] = [];
      const rows = table.querySelectorAll("tr");
      for (const tr of Array.from(rows)) {
        const cells = tr.querySelectorAll("th, td");
        const values = Array.from(cells).map((cell) => {
          const text = (cell as HTMLElement).innerText.trim();
          return `"${text.replace(/"/g, '""')}"`;
        });
        csvRows.push(values.join(","));
      }

      if (csvRows.length === 0) return;

      // Build default file name: {basename}_Table{N}.csv
      const fileName = filePath.replace(/[\\/]/g, "/").split("/").pop() ?? "document.md";
      const baseName = fileName.replace(/\.\w+$/, "");
      const defaultDir = filePath.replace(/[\\/][^\\/]+$/, "");
      const tableNum = tableIndex + 1;
      const defaultPath = `${defaultDir}/${baseName}_Table${tableNum}.csv`;

      const savePath = await save({
        defaultPath,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!savePath) return;

      // UTF-8 with BOM
      const csvContent = "\uFEFF" + csvRows.join("\n");
      await invoke("write_text_file", { path: savePath, content: csvContent });
    } catch (error) {
      console.error("CSV export error:", error);
    }
  }, [filePath]);

  // Markdown rendering with source-line annotation (front matter → preprocess chain → marked)
  useEffect(() => {
    if (!isRenderableMarkdown) {
      setFrontMatter(null);
      setHtml("");
      return;
    }
    try {
      const { meta, body, bodyLineOffset } = splitFrontMatter(content);
      setFrontMatter(meta);
      mermaidCounter = 0;
      const result = renderMarkdownWithSourceLines(body, bodyLineOffset);
      setHtml(result);
    } catch (error) {
      console.error("Markdown rendering error:", error);
      setHtml(`<p>${t("renderError")}</p>`);
    }
  }, [content, isRenderableMarkdown, t]);

  // Manually write HTML to contentRef and convert relative image paths to blob URLs
  const blobUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    // Revoke previous blob URLs
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current = [];

    const div = contentRef.current;
    if (!div) return;

    const scrollContainer = previewRef.current;
    if (scrollContainer) scrollContainer.dataset.contentUpdating = "1";
    div.innerHTML = html;
    requestAnimationFrame(() => {
      if (scrollContainer) delete scrollContainer.dataset.contentUpdating;
    });

    if (!filePath) return;
    const dir = filePath.replace(/[\\/][^\\/]+$/, "");
    const imgs = Array.from(div.querySelectorAll<HTMLImageElement>("img"));
    const blobUrls = blobUrlsRef.current;

    (async () => {
      for (const img of imgs) {
        const rawSrc = img.getAttribute("src");
        if (!rawSrc) continue;
        if (/^(https?:|data:|blob:)/i.test(rawSrc)) continue;

        // Decode URL-encoded paths back to filesystem paths
        const src = decodeURIComponent(rawSrc);

        // Resolve relative path to absolute path
        const combined = dir.replace(/\\/g, "/") + "/" + src;
        const parts = combined.split("/");
        const resolved: string[] = [];
        for (const p of parts) {
          if (p === "..") resolved.pop();
          else if (p !== ".") resolved.push(p);
        }
        const absolutePath = resolved.join("/");

        try {
          const data = await readFile(absolutePath);
          const ext = src.split(".").pop()?.toLowerCase() ?? "";
          const mime =
            ext === "svg" ? "image/svg+xml" :
            ext === "png" ? "image/png" :
            ext === "gif" ? "image/gif" :
            ext === "webp" ? "image/webp" :
            ext === "bmp" ? "image/bmp" :
            "image/jpeg";
          const blob = new Blob([data], { type: mime });
          const url = URL.createObjectURL(blob);
          blobUrls.push(url);
          img.src = url;
          img.dataset.filepath = absolutePath;
        } catch {
          // Skip if file not found
        }
      }
    })();
  }, [html, filePath]);

  // Add copy button to code blocks
  useEffect(() => {
    const div = contentRef.current;
    if (!div) return;

    const pres = div.querySelectorAll<HTMLPreElement>("pre");
    const controllers: AbortController[] = [];

    for (const pre of Array.from(pres)) {
      // Skip if button already exists
      if (pre.querySelector(".code-copy-btn")) continue;
      // Skip pre elements inside Mermaid placeholders
      if (pre.closest(".mermaid-placeholder")) continue;

      pre.style.position = "relative";

      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.title = "Copy";
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
        '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
        '</svg>';

      const ac = new AbortController();
      controllers.push(ac);

      btn.addEventListener("click", () => {
        const code = pre.querySelector("code");
        const text = code?.textContent ?? pre.textContent ?? "";
        navigator.clipboard.writeText(text);
        btn.classList.add("code-copy-btn--copied");
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<polyline points="20 6 9 17 4 12"/>' +
          '</svg>';
        setTimeout(() => {
          btn.classList.remove("code-copy-btn--copied");
          btn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
            '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
            '</svg>';
        }, 1500);
      }, { signal: ac.signal });

      pre.appendChild(btn);
    }

    return () => {
      for (const ac of controllers) ac.abort();
    };
  }, [html]);

  // Double-click images in preview to open as tab
  useEffect(() => {
    const div = contentRef.current;
    if (!div || !onOpenFile) return;
    const handler = (e: MouseEvent) => {
      const img = (e.target as HTMLElement).closest<HTMLImageElement>("img[data-filepath]");
      if (img) onOpenFile(img.dataset.filepath!);
    };
    div.addEventListener("dblclick", handler);
    return () => div.removeEventListener("dblclick", handler);
  }, [onOpenFile]);

  // Search highlight
  const showSearch = useUiStore((s) => s.showSearch);
  const searchText = useUiStore((s) => s.searchText);
  const currentMatchIndex = useUiStore((s) => s.currentMatchIndex);

  useEffect(() => {
    const div = contentRef.current;
    if (!div) return;

    // Clear existing highlights
    const existing = div.querySelectorAll("mark.search-highlight");
    for (const el of Array.from(existing)) {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent || ""), el);
        parent.normalize();
      }
    }

    if (!showSearch || !searchText) return;

    const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let regex: RegExp;
    try {
      regex = new RegExp(escaped, "gi");
    } catch {
      return;
    }

    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Skip inside pre/code
        let parent = node.parentElement;
        while (parent && parent !== div) {
          const tag = parent.tagName.toLowerCase();
          if (tag === "pre" || tag === "code") return NodeFilter.FILTER_REJECT;
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text);
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent || "";
      regex.lastIndex = 0;
      const matches: { start: number; end: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text))) {
        matches.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) break;
      }
      if (matches.length === 0) continue;

      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      for (const { start, end } of matches) {
        if (start > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, start)));
        }
        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = text.slice(start, end);
        frag.appendChild(mark);
        lastIdx = end;
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }, [html, showSearch, searchText]);

  // Scroll to active highlight
  useEffect(() => {
    const div = contentRef.current;
    if (!div || currentMatchIndex < 0) return;

    const marks = div.querySelectorAll("mark.search-highlight");
    // Clear existing active class
    for (const m of Array.from(marks)) {
      m.classList.remove("search-highlight--active");
    }
    if (marks.length === 0) return;

    const idx = currentMatchIndex % marks.length;
    const active = marks[idx];
    active.classList.add("search-highlight--active");
    active.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentMatchIndex]);

  // Mermaid + KaTeX rendering
  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;

    let cancelled = false;

    const timerId = setTimeout(async () => {
      if (cancelled) return;

      // --- Mermaid ---
      const placeholders = container.querySelectorAll<HTMLElement>(
        ".mermaid-placeholder:not([data-rendered='done'])"
      );
      for (const placeholder of Array.from(placeholders)) {
        if (cancelled) return;
        if (placeholder.getAttribute("data-rendered") === "pending") continue;

        const source = decodeURIComponent(
          placeholder.getAttribute("data-mermaid-source") || ""
        );
        if (!source) continue;

        placeholder.setAttribute("data-rendered", "pending");

        try {
          const renderId = `mmrd-${Date.now().toString(36)}-${((Math.random() * 0xffffff) | 0).toString(36)}`;
          const { svg } = await mermaid.render(renderId, source);

          if (cancelled) {
            placeholder.removeAttribute("data-rendered");
            return;
          }

          const tempDiv = document.createElement("div");
          tempDiv.innerHTML = svg;
          const svgNode = tempDiv.querySelector("svg");
          if (!svgNode) throw new Error("No SVG element in mermaid output");

          const rendered = document.createElement("div");
          rendered.className = "mermaid-rendered";
          rendered.appendChild(svgNode);

          const wrapper = document.createElement("div");
          wrapper.className = "mermaid-container";
          wrapper.appendChild(rendered);

          placeholder.innerHTML = "";
          placeholder.appendChild(wrapper);
          placeholder.setAttribute("data-rendered", "done");
        } catch (err) {
          console.error("Mermaid render error:", err);
          placeholder.removeAttribute("data-rendered");
          const errDiv = document.createElement("div");
          errDiv.className = "mermaid-error";
          errDiv.textContent = `Mermaid: ${err instanceof Error ? err.message : String(err)}`;
          placeholder.innerHTML = "";
          placeholder.appendChild(errDiv);
        }
      }

      // --- KaTeX (inline/block) ---
      if (cancelled) return;
      const mathBlocks = container.querySelectorAll<HTMLElement>(".math-block[data-math]");
      for (const el of Array.from(mathBlocks)) {
        const encoded = el.getAttribute("data-math") || "";
        try {
          const math = decodeURIComponent(escape(atob(encoded)));
          katex.render(math, el, { displayMode: true, throwOnError: false });
        } catch { /* skip */ }
      }
      const mathInlines = container.querySelectorAll<HTMLElement>(".math-inline[data-math]");
      for (const el of Array.from(mathInlines)) {
        const encoded = el.getAttribute("data-math") || "";
        try {
          const math = decodeURIComponent(escape(atob(encoded)));
          katex.render(math, el, { displayMode: false, throwOnError: false });
        } catch { /* skip */ }
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [html]);

  const isOfficeFile = !!(activeTab?.binaryData && activeTab?.officeFileType);
  const isDocx = activeTab?.filePath?.toLowerCase().endsWith(".docx");
  const isPdf = activeTab?.filePath?.toLowerCase().endsWith(".pdf");
  const isXlsx =
    activeTab?.filePath?.toLowerCase().endsWith(".xlsx") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlsm") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlam");
  const isMacroEnabled =
    activeTab?.filePath?.toLowerCase().endsWith(".xlsm") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlam");

  // Check if macros directory exists (for showing Import button)
  useEffect(() => {
    if (!isMacroEnabled || !activeTab?.filePath) {
      setMacrosDirExists(false);
      return;
    }
    const lastDot = activeTab.filePath.lastIndexOf(".");
    const macrosDir = activeTab.filePath.substring(0, lastDot) + "_assets/macros";
    import("@tauri-apps/plugin-fs").then(({ exists }) =>
      exists(macrosDir).then(setMacrosDirExists)
    );
  }, [isMacroEnabled, activeTab?.filePath]);

  // Sync active xlsm/xlam path to Rust state for LLM bridge
  useEffect(() => {
    const fp = activeTab?.filePath ?? null;
    const isMacroFile =
      fp !== null &&
      (fp.toLowerCase().endsWith(".xlsm") ||
        fp.toLowerCase().endsWith(".xlam"));
    invoke("set_active_xlsm_path", {
      path: isMacroFile ? fp : null,
    }).catch(() => {});
  }, [activeTab?.filePath]);

  const handleConvertToMarkdown = useCallback(async () => {
    if (!activeTab?.binaryData || !activeTab?.filePath) return;
    setConverting(true);
    setConvertError(null);
    try {
      let mdPath: string;
      if (activeTab.filePath.toLowerCase().endsWith(".pdf")) {
        const { pdfToMarkdown } = await import("@/features/export/lib/pdfToMarkdown");
        ({ mdPath } = await pdfToMarkdown(activeTab.binaryData, activeTab.filePath, false));
      } else if (
        activeTab.filePath.toLowerCase().endsWith(".xlsx") ||
        activeTab.filePath.toLowerCase().endsWith(".xlsm") ||
        activeTab.filePath.toLowerCase().endsWith(".xlam")
      ) {
        const { xlsxToMarkdown } = await import(
          "@/features/export/lib/xlsxToMarkdown"
        );
        ({ mdPath } = await xlsxToMarkdown(
          activeTab.binaryData,
          activeTab.filePath,
          false,
        ));
      } else {
        ({ mdPath } = await docxToMarkdown(activeTab.binaryData, activeTab.filePath, false));
      }
      onRefreshFileTree?.();
      onOpenFile?.(mdPath);
    } catch (e) {
      setConvertError(e instanceof Error ? e.message : String(e));
    } finally {
      setConverting(false);
    }
  }, [activeTab?.binaryData, activeTab?.filePath, onOpenFile, onRefreshFileTree]);

  const handleExportMacros = useCallback(async () => {
    if (!activeTab?.filePath) return;
    setMacroExporting(true);
    setMacroError(null);
    setMacroSuccess(null);
    try {
      const result = await invoke<{ macrosDir: string; modules: { name: string; moduleType: string; path: string }[] }>(
        "extract_vba_modules",
        { xlsmPath: activeTab.filePath }
      );
      setMacroSuccess(t("macroExportSuccess", { count: result.modules.length }));
      setMacrosDirExists(true);
      onRefreshFileTree?.();
    } catch (e) {
      setMacroError(e instanceof Error ? e.message : String(e));
    } finally {
      setMacroExporting(false);
    }
  }, [activeTab?.filePath, onRefreshFileTree, t]);

  const handleImportMacros = useCallback(async () => {
    if (!activeTab?.filePath) return;
    setMacroImporting(true);
    setMacroError(null);
    setMacroSuccess(null);
    try {
      const filePath = activeTab.filePath;
      const lastDot = filePath.lastIndexOf(".");
      const macrosDir = filePath.substring(0, lastDot) + "_assets/macros";

      const result = await invoke<{ backupPath: string; updatedModules: string[] }>(
        "inject_vba_modules",
        { xlsmPath: filePath, macrosDir }
      );
      setMacroSuccess(t("macroImportSuccess", { count: result.updatedModules.length }));

      // Reload binary data to refresh preview
      const bytes = await invoke<number[]>("read_binary_file", { path: filePath });
      const binaryData = new Uint8Array(bytes);
      const tabs = useTabStore.getState().tabs;
      const activeId = useTabStore.getState().activeTabId;
      useTabStore.setState({
        tabs: tabs.map((tab) =>
          tab.id === activeId ? { ...tab, binaryData } : tab
        ),
      });

      // Ask user if they want to open the file
      const shouldOpen = await showConfirm(t("macroImportOpenFile"));
      if (shouldOpen) {
        await invoke("open_in_default_app", { path: filePath });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Try to parse structured error from Rust (module_set_changed carries JSON)
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error === "module_set_changed") {
          const newList = (parsed.newInFiles ?? []).join(", ") || "-";
          const missingList = (parsed.missingInFiles ?? []).join(", ") || "-";
          setMacroError(
            t("macroModuleSetChanged", { new: newList, missing: missingList })
          );
          return;
        }
      } catch {
        // Not JSON; fall through to raw message
      }
      setMacroError(msg);
    } finally {
      setMacroImporting(false);
    }
  }, [activeTab?.filePath, t]);

  // Show VideoPanel for .video.json files
  if (isVideoJson) {
    return (
      <div className="preview-panel">
        <VideoPanel />
      </div>
    );
  }

  // Show CsvPreviewPanel for CSV/TSV files
  if (activeTab?.csvFileType) {
    return (
      <div className="preview-panel" ref={previewRef}>
        <CsvPreviewPanel />
      </div>
    );
  }

  // Show OfficePreview for Office files
  if (isOfficeFile) {
    return (
      <div className="preview-panel">
        {(isDocx || isPdf || isXlsx) && (
          <div className="preview-panel__convert-bar">
            <button
              onClick={handleConvertToMarkdown}
              disabled={converting}
            >
              {converting ? t("converting") : t("convertToMarkdown")}
            </button>
            {isMacroEnabled && (
              <button
                onClick={handleExportMacros}
                disabled={macroExporting || macroImporting}
              >
                {macroExporting ? t("exportingMacros") : t("exportMacros")}
              </button>
            )}
            {isMacroEnabled && macrosDirExists && (
              <button
                onClick={handleImportMacros}
                disabled={macroImporting || macroExporting}
              >
                {macroImporting ? t("importingMacros") : t("importMacros")}
              </button>
            )}
            {isMacroEnabled && (
              <label className="preview-panel__llm-toggle">
                <input
                  type="checkbox"
                  checked={allowLlmVbaImport}
                  onChange={(e) => {
                    setAllowLlmVbaImport(e.target.checked);
                    syncMdiumVbaMcpConfig().catch(() => {});
                  }}
                />
                <span title={t("allowLlmVbaImportHint") ?? ""}>
                  {t("allowLlmVbaImport")}
                </span>
              </label>
            )}
            {convertError && (
              <span className="preview-panel__convert-error">{convertError}</span>
            )}
            {macroError && (
              <span className="preview-panel__convert-error">{macroError}</span>
            )}
            {macroSuccess && (
              <span className="preview-panel__convert-success">{macroSuccess}</span>
            )}
          </div>
        )}
        <div className="preview-panel__office-wrap" ref={previewRef}>
          <OfficePreview
            key={activeTab!.filePath}
            fileData={activeTab!.binaryData!}
            fileType={activeTab!.officeFileType!}
            themeType={themeType}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="preview-panel">
      <div className="preview-panel__tabs">
        <button
          className={`preview-panel__tab ${activeViewTab === "preview" ? "preview-panel__tab--active" : ""}`}
          onClick={() => setActiveViewTab("preview")}
        >
          {t("preview")}
        </button>
        <button
          className={`preview-panel__tab preview-panel__tab--icon ${activeViewTab === "pdf-preview" ? "preview-panel__tab--active" : ""}`}
          onClick={() => setActiveViewTab("pdf-preview")}
          title={t("pdfPreview")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <text x="12" y="16" textAnchor="middle" fill="currentColor" stroke="none" fontSize="6" fontWeight="bold" fontFamily="sans-serif">PDF</text>
          </svg>
        </button>
        <button
          className={`preview-panel__tab preview-panel__tab--icon ${activeViewTab === "docx-preview" ? "preview-panel__tab--active" : ""}`}
          onClick={() => setActiveViewTab("docx-preview")}
          title={t("docxPreview")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <text x="12" y="16" textAnchor="middle" fill="currentColor" stroke="none" fontSize="8" fontWeight="bold" fontFamily="sans-serif">W</text>
          </svg>
        </button>
        <button
          className={`preview-panel__tab preview-panel__tab--icon ${activeViewTab === "html-preview" ? "preview-panel__tab--active" : ""}`}
          onClick={() => setActiveViewTab("html-preview")}
          title={t("htmlPreview")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
            <line x1="14" y1="4" x2="10" y2="20" />
          </svg>
        </button>
        {isSlidev && (
          <button
            className={`preview-panel__tab preview-panel__tab--icon ${activeViewTab === "slidev-preview" ? "preview-panel__tab--active" : ""}`}
            onClick={() => setActiveViewTab("slidev-preview")}
            title="Slidev"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </button>
        )}
        <div className="preview-panel__command-group">
          <span className="preview-panel__command-label">{t("executeCommand")}</span>
          <select
            className="preview-panel__command-select"
            value=""
            onChange={(e) => {
              if (e.target.value) {
                handleCommandSelect(e.target.value);
                e.target.value = "";
              }
            }}
          >
            <option value="" disabled />
            {Object.keys(globalCommands).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="preview-panel__body">
        <div
          className="preview-panel__content md-preview"
          ref={previewRef}
          onClick={() => setContextMenu(null)}
        >
          {isZennArticleFile && parsedZennFrontmatter ? (
            <ZennFrontmatterForm
              frontmatter={parsedZennFrontmatter}
              onChange={handleZennFrontmatterChange}
            />
          ) : (
            frontMatter && (
              <div className="yaml-front-matter">
                {Object.entries(frontMatter).map(([k, v]) => (
                  <div key={k} className="yaml-entry">
                    <span className="yaml-key">{k}</span>
                    <span className="yaml-value">{v}</span>
                  </div>
                ))}
              </div>
            )
          )}
          <div ref={contentRef} />
        </div>

        {activeViewTab === "pdf-preview" && (
          <div className="preview-panel__pdf-overlay">
            <PdfPreviewPanel
              previewRef={previewRef}
              filePath={filePath}
            />
          </div>
        )}

        {activeViewTab === "docx-preview" && (
          <div className="preview-panel__pdf-overlay">
            <DocxPreviewPanel
              previewRef={previewRef}
              content={content}
              filePath={filePath}
            />
          </div>
        )}

        {activeViewTab === "html-preview" && (
          <div className="preview-panel__pdf-overlay">
            <HtmlPreviewPanel
              previewRef={previewRef}
              filePath={filePath}
            />
          </div>
        )}

        {activeViewTab === "slidev-preview" && (
          <div className="preview-panel__pdf-overlay">
            <SlidevPreviewPanel
              content={content}
              filePath={filePath}
            />
          </div>
        )}

      </div>

      {activeViewTab === "preview" && contextMenu && (
        <div
          className="preview-table-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <div className="preview-table-ctx-group">
            <button
              onClick={() =>
                addRow(
                  contextMenu.tableIndex,
                  "above",
                  Math.max(contextMenu.row, 0),
                )
              }
            >
              {t("insertRowAbove", { defaultValue: "Insert row above" })}
            </button>
            <button
              onClick={() =>
                addRow(
                  contextMenu.tableIndex,
                  "below",
                  Math.max(contextMenu.row, 0),
                )
              }
            >
              {t("insertRowBelow", { defaultValue: "Insert row below" })}
            </button>
            {contextMenu.row >= 0 && (
              <button
                onClick={() =>
                  deleteRow(contextMenu.tableIndex, contextMenu.row)
                }
              >
                {t("deleteRow", { defaultValue: "Delete row" })}
              </button>
            )}
          </div>
          <div className="preview-table-ctx-divider" />
          <div className="preview-table-ctx-group">
            <button
              onClick={() =>
                addColumn(contextMenu.tableIndex, "left", contextMenu.col)
              }
            >
              {t("insertColLeft", { defaultValue: "Insert column left" })}
            </button>
            <button
              onClick={() =>
                addColumn(contextMenu.tableIndex, "right", contextMenu.col)
              }
            >
              {t("insertColRight", { defaultValue: "Insert column right" })}
            </button>
            <button
              onClick={() =>
                deleteColumn(contextMenu.tableIndex, contextMenu.col)
              }
            >
              {t("deleteCol", { defaultValue: "Delete column" })}
            </button>
          </div>
          <div className="preview-table-ctx-divider" />
          <div className="preview-table-ctx-group">
            <button
              onClick={() =>
                exportTableCsv(contextMenu.tableIndex)
              }
            >
              {t("exportTableCsv", { defaultValue: "Export to CSV" })}
            </button>
          </div>
        </div>
      )}

      {mediumDialog && (
        <MediumPublishDialog
          defaultTitle={mediumDialog.title}
          defaultTags={mediumDialog.tags}
          defaultCanonicalUrl={mediumDialog.canonicalUrl}
          onSubmit={handleMediumSubmit}
          onCancel={() => setMediumDialog(null)}
        />
      )}

      {scenarioDialog && (
        <VideoScenarioDialog
          hasExisting={scenarioDialog.hasExisting}
          fileName={scenarioDialog.videoJsonName}
          onSubmit={handleScenarioSubmit}
          onCancel={handleScenarioCancel}
        />
      )}
    </div>
  );
}

/** Convert "rgb(r,g,b)" / "rgba(r,g,b,a)" → "#rrggbb" */
function rgbToHex(val: string): string {
  const m = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return val;
  return (
    "#" +
    [m[1], m[2], m[3]]
      .map((n) => parseInt(n).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Convert a live DOM Mermaid SVG into a standalone SVG string.
 * - Set absolute pixel dimensions from viewBox (overriding width="100%")
 * - Inline computed styles as attributes
 * - Remove <style> tags
 * - Convert <foreignObject> to SVG <text>
 * - Unify font-family to a safe font
 */
export function processSvgForStandaloneUse(liveSvgEl: SVGSVGElement): string {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SAFE_FONT = "Meiryo, Yu Gothic, Segoe UI, Arial, sans-serif";

  const clone = liveSvgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  // Determine size from viewBox (override relative values like width="100%")
  const viewBox = clone.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/\s+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      clone.setAttribute("width", `${parts[2]}px`);
      clone.setAttribute("height", `${parts[3]}px`);
    }
  }

  // Map live elements to clone elements 1:1 and inline computed styles as attributes.
  // Skip elements inside foreignObject as they are HTML elements (not SVGElement).
  const liveEls = Array.from(liveSvgEl.querySelectorAll("*"));
  const cloneEls = Array.from(clone.querySelectorAll("*"));

  const PROPS = [
    "fill", "fill-opacity",
    "stroke", "stroke-width", "stroke-opacity",
    "font-size", "font-weight", "font-style",
    "opacity",
  ];

  for (let i = 0; i < liveEls.length && i < cloneEls.length; i++) {
    const liveEl = liveEls[i];
    const cloneEl = cloneEls[i];
    if (!(liveEl instanceof SVGElement)) continue;
    try {
      const computed = getComputedStyle(liveEl);
      for (const prop of PROPS) {
        const val = computed.getPropertyValue(prop);
        if (!val || val === "initial" || val === "inherit") continue;
        cloneEl.setAttribute(prop, val.startsWith("url(") ? val : rgbToHex(val));
      }
    } catch {
      // Skip if getComputedStyle fails (can occur near foreignObject)
    }
  }

  // Remove <style> tags since styles are already inlined as attributes
  for (const el of Array.from(clone.querySelectorAll("style"))) {
    el.remove();
  }

  // Convert <foreignObject> → SVG <text>
  for (const fo of Array.from(clone.querySelectorAll("foreignObject"))) {
    const rawText = fo.textContent?.trim() ?? "";
    if (!rawText) {
      fo.remove();
      continue;
    }

    const x = parseFloat(fo.getAttribute("x") || "0");
    const y = parseFloat(fo.getAttribute("y") || "0");
    const w = parseFloat(fo.getAttribute("width") || "0");
    const h = parseFloat(fo.getAttribute("height") || "0");

    const lines = rawText.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const fontSize = 14;
    const lineHeight = fontSize * 1.4;

    const textEl = document.createElementNS(SVG_NS, "text");
    textEl.setAttribute("font-family", SAFE_FONT);
    textEl.setAttribute("font-size", String(fontSize));
    textEl.setAttribute("fill", "#333333");
    textEl.setAttribute("text-anchor", "middle");

    if (lines.length === 1) {
      textEl.setAttribute("x", String(x + w / 2));
      textEl.setAttribute("y", String(y + h / 2));
      textEl.setAttribute("dominant-baseline", "middle");
      textEl.textContent = lines[0];
    } else {
      const totalH = (lines.length - 1) * lineHeight;
      const startY = y + h / 2 - totalH / 2;
      textEl.setAttribute("x", String(x + w / 2));
      textEl.setAttribute("y", String(startY));
      for (let li = 0; li < lines.length; li++) {
        const tspan = document.createElementNS(SVG_NS, "tspan");
        tspan.setAttribute("x", String(x + w / 2));
        if (li > 0) tspan.setAttribute("dy", String(lineHeight));
        tspan.textContent = lines[li];
        textEl.appendChild(tspan);
      }
    }

    fo.parentNode?.replaceChild(textEl, fo);
  }

  // Set font-family on all text/tspan elements
  for (const el of Array.from(clone.querySelectorAll("text, tspan"))) {
    el.setAttribute("font-family", SAFE_FONT);
  }

  return new XMLSerializer().serializeToString(clone);
}
