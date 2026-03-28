import { useCallback } from "react";
import { makeHeadingId } from "@/shared/lib/markdown/heading-id";

interface UseEditorFormattingParams {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  onContentChange: (newContent: string) => void;
}

export function useEditorFormatting({
  editorRef,
  content,
  onContentChange,
}: UseEditorFormattingParams) {
  const handleInsertFormatting = useCallback(
    (format: string) => {
      const textarea = editorRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = content.substring(start, end);
      const before = content.substring(0, start);
      const after = content.substring(end);

      let newContent = content;
      let newSelStart = start;
      let newSelEnd = end;

      const wrapInline = (marker: string) => {
        const text = selected || "Text";
        newContent = `${before}${marker}${text}${marker}${after}`;
        newSelStart = start + marker.length;
        newSelEnd = newSelStart + text.length;
      };

      const prefixLines = (prefix: string) => {
        if (selected) {
          const lines = selected
            .split("\n")
            .map((l) => `${prefix}${l}`)
            .join("\n");
          newContent = `${before}${lines}${after}`;
          newSelStart = start;
          newSelEnd = start + lines.length;
        } else {
          const lineStart = before.lastIndexOf("\n") + 1;
          newContent =
            content.substring(0, lineStart) +
            prefix +
            content.substring(lineStart);
          newSelStart = start + prefix.length;
          newSelEnd = newSelStart;
        }
      };

      switch (format) {
        case "bold":
          wrapInline("**");
          break;
        case "italic":
          wrapInline("*");
          break;
        case "strike":
          wrapInline("~~");
          break;
        case "code":
          if (selected.includes("\n")) {
            newContent = `${before}\`\`\`\n${selected}\n\`\`\`${after}`;
            newSelStart = start + 4;
            newSelEnd = newSelStart + selected.length;
          } else {
            wrapInline("`");
          }
          break;
        case "h1":
          prefixLines("# ");
          break;
        case "h2":
          prefixLines("## ");
          break;
        case "h3":
          prefixLines("### ");
          break;
        case "ul":
          prefixLines("- ");
          break;
        case "ol":
          prefixLines("1. ");
          break;
        case "quote":
          prefixLines("> ");
          break;
        case "link": {
          const text = selected || "Link text";
          newContent = `${before}[${text}](url)${after}`;
          newSelStart = start + 1;
          newSelEnd = newSelStart + text.length;
          break;
        }
        case "hr": {
          const nl = before.endsWith("\n") || before === "" ? "" : "\n";
          newContent = `${before}${nl}---\n${after}`;
          newSelStart = start + nl.length + 4;
          newSelEnd = newSelStart;
          break;
        }
        case "pagebreak": {
          const nl = before.endsWith("\n") || before === "" ? "" : "\n";
          const marker = "<!-- pagebreak -->";
          newContent = `${before}${nl}${marker}\n${after}`;
          newSelStart = start + nl.length + marker.length + 1;
          newSelEnd = newSelStart;
          break;
        }
        case "codeblock": {
          const nl = before.endsWith("\n") || before === "" ? "" : "\n";
          const text = selected || "";
          newContent = `${before}${nl}\`\`\`\n${text}\n\`\`\`\n${after}`;
          newSelStart = start + nl.length + 4;
          newSelEnd = newSelStart + text.length;
          break;
        }
        case "details": {
          const nl = before.endsWith("\n") || before === "" ? "" : "\n";
          const summary = selected || "Click to expand";
          const block = `${nl}<details>\n<summary>${summary}</summary>\n\n\n</details>\n`;
          newContent = `${before}${block}${after}`;
          // Place cursor on the empty line inside the block
          newSelStart = before.length + nl.length + "<details>\n<summary>".length + summary.length + "</summary>\n\n".length;
          newSelEnd = newSelStart;
          break;
        }
        default:
          return;
      }

      onContentChange(newContent);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newSelStart, newSelEnd);
      }, 0);
    },
    [content, onContentChange, editorRef]
  );

  const handleInsertTable = useCallback(
    (rows: number, cols: number) => {
      const textarea = editorRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const before = content.substring(0, start);
      const after = content.substring(start);

      const nl = before.endsWith("\n") || before === "" ? "" : "\n";
      const headers = Array.from({ length: cols }, (_, i) => ` Col${i + 1} `).join("|");
      const separator = Array.from({ length: cols }, () => " --- ").join("|");
      const emptyRow = Array.from({ length: cols }, () => "  ").join("|");
      const dataRows = Array.from({ length: rows }, () => `|${emptyRow}|`).join("\n");

      const table = `${nl}|${headers}|\n|${separator}|\n${dataRows}\n`;
      const newContent = `${before}${table}${after}`;

      onContentChange(newContent);

      const cursorTarget =
        before.length + nl.length + `|${headers}|\n|${separator}|\n|`.length + 1;
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(cursorTarget, cursorTarget);
      }, 0);
    },
    [content, onContentChange, editorRef]
  );

  const handleInsertToc = useCallback(() => {
    const regex = /^(#{1,6})\s+(.+)/gm;
    const headings: Array<{ depth: number; text: string }> = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
      headings.push({ depth: match[1].length, text: match[2].trim() });
    }
    if (headings.length === 0) return;

    const minDepth = Math.min(...headings.map((h) => h.depth));
    const toc = headings
      .map((h) => {
        const indent = "  ".repeat(h.depth - minDepth);
        const id = makeHeadingId(h.text);
        return `${indent}- [${h.text}](#${id})`;
      })
      .join("\n");

    const tocBlock = `## Table of Contents\n\n${toc}\n\n`;

    const textarea = editorRef.current;
    let insertPosition = textarea ? textarea.selectionStart : 0;

    if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
      const end = content.indexOf("\n---", 4);
      if (end !== -1) insertPosition = Math.max(insertPosition, end + 5);
    }

    const newContent =
      content.substring(0, insertPosition) +
      tocBlock +
      content.substring(insertPosition);
    onContentChange(newContent);
  }, [content, onContentChange, editorRef]);

  const handleInsertMermaidTemplate = useCallback(
    (mermaidCode: string) => {
      const textarea = editorRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const before = content.substring(0, start);
      const after = content.substring(start);

      const nl = before.endsWith("\n") || before === "" ? "" : "\n";
      const block = `${nl}\`\`\`mermaid\n${mermaidCode}\n\`\`\`\n`;
      const newContent = `${before}${block}${after}`;

      onContentChange(newContent);

      const cursorTarget = before.length + block.length;
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(cursorTarget, cursorTarget);
      }, 0);
    },
    [content, onContentChange, editorRef]
  );

  return { handleInsertFormatting, handleInsertTable, handleInsertToc, handleInsertMermaidTemplate } as const;
}
