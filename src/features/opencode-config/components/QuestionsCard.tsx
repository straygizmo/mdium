import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PendingQuestion } from "../hooks/useOpencodeChat";

interface QuestionsCardProps {
  questions: PendingQuestion[];
  onSubmit: (answers: string) => void;
  disabled?: boolean;
}

export function QuestionsCard({ questions, onSubmit, disabled }: QuestionsCardProps) {
  const { t } = useTranslation("opencode-config");
  // Map of question index → selected option index
  const [selections, setSelections] = useState<Record<number, number>>({});

  const handleSelect = useCallback((qIndex: number, optIndex: number) => {
    setSelections((prev) => ({ ...prev, [qIndex]: optIndex }));
  }, []);

  const allAnswered = questions.every((_, i) => selections[i] !== undefined);

  const handleSubmit = useCallback(() => {
    if (!allAnswered) return;
    const answers = questions
      .map((q, i) => {
        const selected = q.options[selections[i]];
        return selected ? selected.label : "";
      })
      .filter(Boolean);
    // Single question → just the label; multiple → numbered list
    const text = answers.length === 1
      ? answers[0]
      : answers.map((a, i) => `${i + 1}. ${a}`).join("\n");
    onSubmit(text);
  }, [allAnswered, questions, selections, onSubmit]);

  return (
    <div className="oc-chat__questions">
      {questions.map((q, qIndex) => (
        <div key={qIndex} className="oc-chat__question-card">
          {q.header && (
            <div className="oc-chat__question-header">{q.header}</div>
          )}
          <div className="oc-chat__question-text">{q.question}</div>
          <div className="oc-chat__question-options">
            {q.options.map((opt, optIndex) => (
              <button
                key={optIndex}
                className={`oc-chat__question-option${
                  selections[qIndex] === optIndex ? " oc-chat__question-option--selected" : ""
                }`}
                onClick={() => handleSelect(qIndex, optIndex)}
                disabled={disabled}
                type="button"
              >
                <span className="oc-chat__question-option-radio">
                  {selections[qIndex] === optIndex ? "\u25C9" : "\u25CB"}
                </span>
                <span className="oc-chat__question-option-body">
                  <span className="oc-chat__question-option-label">{opt.label}</span>
                  {opt.description && (
                    <span className="oc-chat__question-option-desc">{opt.description}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        className="oc-chat__questions-submit"
        onClick={handleSubmit}
        disabled={!allAnswered || disabled}
        type="button"
      >
        {t("ocChatQuestionsSubmit", "Submit")}
      </button>
    </div>
  );
}
