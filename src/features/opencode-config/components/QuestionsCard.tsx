import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PendingQuestion } from "../hooks/useOpencodeChat";

interface QuestionsCardProps {
  questions: PendingQuestion[];
  /** answers[i] holds the selected option labels (or a free-text entry) for question i. */
  onSubmit: (answers: string[][]) => void;
  /** Dismiss the questions without answering (esc / reject). */
  onReject?: () => void;
  disabled?: boolean;
}

export function QuestionsCard({ questions, onSubmit, onReject, disabled }: QuestionsCardProps) {
  const { t } = useTranslation("opencode-config");
  // Per-question selected option indices (a set supports `multiple`; for
  // single-select it never holds more than one entry).
  const [selected, setSelected] = useState<Record<number, Set<number>>>({});
  // Per-question free-text answer state (only when `custom` is allowed).
  const [customOn, setCustomOn] = useState<Record<number, boolean>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});

  const toggleOption = useCallback(
    (qIndex: number, optIndex: number, multiple: boolean) => {
      setSelected((prev) => {
        const next = { ...prev };
        const current = new Set(prev[qIndex] ?? []);
        if (multiple) {
          if (current.has(optIndex)) current.delete(optIndex);
          else current.add(optIndex);
        } else {
          current.clear();
          current.add(optIndex);
        }
        next[qIndex] = current;
        return next;
      });
      if (!multiple) {
        // Picking a concrete option clears the free-text choice in single mode.
        setCustomOn((prev) => ({ ...prev, [qIndex]: false }));
      }
    },
    []
  );

  const toggleCustom = useCallback((qIndex: number, multiple: boolean) => {
    setCustomOn((prev) => ({ ...prev, [qIndex]: !prev[qIndex] }));
    if (!multiple) {
      // Choosing free-text clears option selections in single mode.
      setSelected((prev) => ({ ...prev, [qIndex]: new Set() }));
    }
  }, []);

  const setCustom = useCallback((qIndex: number, value: string) => {
    setCustomText((prev) => ({ ...prev, [qIndex]: value }));
  }, []);

  const buildAnswer = useCallback(
    (qIndex: number, q: PendingQuestion): string[] => {
      const labels = [...(selected[qIndex] ?? [])]
        .sort((a, b) => a - b)
        .map((oi) => q.options[oi]?.label)
        .filter((l): l is string => !!l);
      if (customOn[qIndex]) {
        const text = (customText[qIndex] ?? "").trim();
        if (text) labels.push(text);
      }
      return labels;
    },
    [selected, customOn, customText]
  );

  const allAnswered = questions.every((q, i) => buildAnswer(i, q).length > 0);

  const handleSubmit = useCallback(() => {
    if (!allAnswered) return;
    onSubmit(questions.map((q, i) => buildAnswer(i, q)));
  }, [allAnswered, questions, buildAnswer, onSubmit]);

  return (
    <div className="oc-chat__questions">
      {questions.map((q, qIndex) => {
        const multiple = q.multiple === true;
        const allowCustom = q.custom !== false;
        const isCustomOn = !!customOn[qIndex];
        return (
          <div key={qIndex} className="oc-chat__question-card">
            {q.header && (
              <div className="oc-chat__question-header">{q.header}</div>
            )}
            <div className="oc-chat__question-text">{q.question}</div>
            <div className="oc-chat__question-options">
              {q.options.map((opt, optIndex) => {
                const isSelected = selected[qIndex]?.has(optIndex) ?? false;
                return (
                  <button
                    key={optIndex}
                    className={`oc-chat__question-option${
                      isSelected ? " oc-chat__question-option--selected" : ""
                    }`}
                    onClick={() => toggleOption(qIndex, optIndex, multiple)}
                    disabled={disabled}
                    type="button"
                  >
                    <span className="oc-chat__question-option-radio">
                      {isSelected ? "◉" : "○"}
                    </span>
                    <span className="oc-chat__question-option-body">
                      <span className="oc-chat__question-option-label">{opt.label}</span>
                      {opt.description && (
                        <span className="oc-chat__question-option-desc">{opt.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
              {allowCustom && (
                <button
                  className={`oc-chat__question-option${
                    isCustomOn ? " oc-chat__question-option--selected" : ""
                  }`}
                  onClick={() => toggleCustom(qIndex, multiple)}
                  disabled={disabled}
                  type="button"
                >
                  <span className="oc-chat__question-option-radio">
                    {isCustomOn ? "◉" : "○"}
                  </span>
                  <span className="oc-chat__question-option-body">
                    <span className="oc-chat__question-option-label">
                      {t("ocChatQuestionsCustom", "Type your own answer")}
                    </span>
                  </span>
                </button>
              )}
            </div>
            {allowCustom && isCustomOn && (
              <input
                className="oc-chat__question-custom-input"
                type="text"
                value={customText[qIndex] ?? ""}
                onChange={(e) => setCustom(qIndex, e.target.value)}
                placeholder={t("ocChatQuestionsCustomPlaceholder", "Type your answer…")}
                disabled={disabled}
                autoFocus
              />
            )}
          </div>
        );
      })}
      <div className="oc-chat__questions-actions">
        {onReject && (
          <button
            className="oc-chat__questions-reject"
            onClick={onReject}
            disabled={disabled}
            type="button"
          >
            {t("ocChatQuestionsDismiss", "Dismiss")}
          </button>
        )}
        <button
          className="oc-chat__questions-submit"
          onClick={handleSubmit}
          disabled={!allAnswered || disabled}
          type="button"
        >
          {t("ocChatQuestionsSubmit", "Submit")}
        </button>
      </div>
    </div>
  );
}
