import { useState, useCallback, useRef } from "react";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";

interface PasteDialogState {
  visible: boolean;
  imageBlob: Blob | null;
  imageUrl: string | null;
  cursorPos: number;
}

interface UseImagePasteParams {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  filePath: string | null;
  onContentChange: (newContent: string) => void;
  onNoFile: () => void;
}

function generateTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

function getDirectoryFromPath(filePath: string): string {
  // Handle both Windows backslash and Unix forward slash
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSep >= 0 ? filePath.substring(0, lastSep) : filePath;
}

export function useImagePaste({
  editorRef,
  content,
  filePath,
  onContentChange,
  onNoFile,
}: UseImagePasteParams) {
  const [pasteDialogState, setPasteDialogState] = useState<PasteDialogState>({
    visible: false,
    imageBlob: null,
    imageUrl: null,
    cursorPos: 0,
  });
  const blobUrlRef = useRef<string | null>(null);

  const cleanupBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      // Text priority: if text data exists, let default paste handle it
      const textData = e.clipboardData.getData("text/plain");
      if (textData) return;

      // Look for image data
      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          imageItem = items[i];
          break;
        }
      }

      if (!imageItem) return;

      e.preventDefault();

      if (!filePath) {
        onNoFile();
        return;
      }

      const blob = imageItem.getAsFile();
      if (!blob) return;

      // Clean up previous blob URL if any
      cleanupBlobUrl();

      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;

      const cursorPos = editorRef.current?.selectionStart ?? 0;

      setPasteDialogState({
        visible: true,
        imageBlob: blob,
        imageUrl: url,
        cursorPos,
      });
    },
    [filePath, onNoFile, editorRef, cleanupBlobUrl],
  );

  const closePasteDialog = useCallback(() => {
    cleanupBlobUrl();
    setPasteDialogState({
      visible: false,
      imageBlob: null,
      imageUrl: null,
      cursorPos: 0,
    });
  }, [cleanupBlobUrl]);

  const confirmPaste = useCallback(
    async (altText: string) => {
      if (!filePath || !pasteDialogState.imageBlob) return;

      const dirPath = getDirectoryFromPath(filePath);
      const imagesDir = `${dirPath}/images`;
      const fileName = `image-${generateTimestamp()}.png`;
      const savePath = `${imagesDir}/${fileName}`;
      const markdownLink = `![${altText}](images/${fileName})`;

      // Save image
      try {
        await mkdir(imagesDir, { recursive: true });
        const arrayBuffer = await pasteDialogState.imageBlob.arrayBuffer();
        await writeFile(savePath, new Uint8Array(arrayBuffer));
      } catch (e) {
        throw new Error(
          e instanceof Error ? e.message : String(e)
        );
      }

      // Insert markdown link at cursor position
      const pos = pasteDialogState.cursorPos;
      const newContent =
        content.substring(0, pos) + markdownLink + content.substring(pos);
      onContentChange(newContent);

      // Move cursor after inserted link
      const newPos = pos + markdownLink.length;
      setTimeout(() => {
        const textarea = editorRef.current;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(newPos, newPos);
        }
      }, 0);

      closePasteDialog();
    },
    [filePath, pasteDialogState, content, onContentChange, editorRef, closePasteDialog],
  );

  return {
    handlePaste,
    pasteDialogState,
    closePasteDialog,
    confirmPaste,
  };
}
