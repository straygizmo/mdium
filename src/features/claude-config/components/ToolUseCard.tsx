import { useTranslation } from "react-i18next";
import type { ClaudeToolPart } from "../lib/claude-message-mapper";

export function ToolUseCard({ part }: { part: ClaudeToolPart }) {
  const { t } = useTranslation("claude-config");
  const status = !part.done
    ? t("toolRunning")
    : part.isError
      ? t("toolFailed")
      : "✓";
  return (
    <details className="claude-tool">
      <summary className="claude-tool__summary">
        <span className="claude-tool__name">{part.name}</span>
        <span className={`claude-tool__status${part.isError ? " claude-tool__status--error" : ""}`}>
          {status}
        </span>
      </summary>
      <pre className="claude-tool__body">{JSON.stringify(part.input, null, 2)}</pre>
      {part.output ? <pre className="claude-tool__body">{part.output}</pre> : null}
    </details>
  );
}
