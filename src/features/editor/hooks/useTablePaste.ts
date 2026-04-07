import { useCallback } from "react";
import { htmlTableToMarkdown } from "../lib/htmlTableToMarkdown";

interface UseTablePasteParams {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  onContentChange: (newContent: string) => void;
}

/**
 * Hook that intercepts paste events containing HTML tables
 * and converts them to markdown table syntax.
 *
 * Returns a handler that should be called BEFORE the image paste handler.
 * Returns true if a table was detected and inserted, false otherwise.
 */
export function useTablePaste({
  editorRef,
  content,
  onContentChange,
}: UseTablePasteParams) {
  const handleTablePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>): boolean => {
      const html = e.clipboardData?.getData("text/html");
      if (!html) return false;

      const markdown = htmlTableToMarkdown(html);
      if (!markdown) return false;

      e.preventDefault();

      const textarea = editorRef.current;
      const start = textarea?.selectionStart ?? 0;
      const end = textarea?.selectionEnd ?? 0;

      const before = content.substring(0, start);
      const after = content.substring(end);

      // Add newlines around the table if needed
      const nlBefore = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      const nlAfter = after.length > 0 && !after.startsWith("\n") ? "\n" : "";

      const newContent = before + nlBefore + markdown + nlAfter + after;
      onContentChange(newContent);

      // Move cursor after inserted table
      const newPos = start + nlBefore.length + markdown.length + nlAfter.length;
      setTimeout(() => {
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(newPos, newPos);
        }
      }, 0);

      return true;
    },
    [editorRef, content, onContentChange]
  );

  return { handleTablePaste };
}
