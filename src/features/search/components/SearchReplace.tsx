import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import "./SearchReplace.css";

interface SearchReplaceProps {
  onClose: () => void;
}

export function SearchReplace({ onClose }: SearchReplaceProps) {
  const { t } = useTranslation("editor");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);
  const searchMode = useUiStore((s) => s.searchMode);
  const setSearchMode = useUiStore((s) => s.setSearchMode);
  const searchText = useUiStore((s) => s.searchText);
  const setSearchText = useUiStore((s) => s.setSearchText);
  const currentMatchIndex = useUiStore((s) => s.currentMatchIndex);
  const setCurrentMatchIndex = useUiStore((s) => s.setCurrentMatchIndex);

  const [replaceText, setReplaceText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const isReplace = searchMode === "replace";

  const content = activeTab?.content ?? "";

  const matchCount = searchText
    ? (content.match(new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || [])
        .length
    : 0;

  const handleReplace = useCallback(() => {
    if (!searchText || !activeTab) return;
    const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const newContent = content.replace(regex, replaceText);
    updateTabContent(activeTab.id, newContent);
  }, [searchText, replaceText, content, activeTab, updateTabContent]);

  const goToNext = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentMatchIndex(currentMatchIndex + 1 >= matchCount ? 0 : currentMatchIndex + 1);
  }, [matchCount, currentMatchIndex, setCurrentMatchIndex]);

  const goToPrev = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentMatchIndex(currentMatchIndex <= 0 ? matchCount - 1 : currentMatchIndex - 1);
  }, [matchCount, currentMatchIndex, setCurrentMatchIndex]);

  const handleReplaceAll = useCallback(() => {
    if (!searchText || !activeTab) return;
    const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const newContent = content.replace(regex, replaceText);
    updateTabContent(activeTab.id, newContent);
  }, [searchText, replaceText, content, activeTab, updateTabContent]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && !e.ctrlKey) {
        e.preventDefault();
        goToNext();
      } else if (e.key === "Enter" && e.ctrlKey && isReplace) {
        handleReplaceAll();
      }
    },
    [onClose, handleReplaceAll, isReplace, goToNext, goToPrev]
  );

  const toggleMode = useCallback(() => {
    setSearchMode(isReplace ? "search" : "replace");
  }, [isReplace, setSearchMode]);

  // グローバル F3 キーハンドラー（検索パネル外でも動作）
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F3") {
        e.preventDefault();
        if (e.shiftKey) {
          goToPrev();
        } else {
          goToNext();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [goToNext, goToPrev]);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, [searchMode]);

  return (
    <div className="search-replace" onKeyDown={handleKeyDown}>
      <div className="search-replace__body">
        <button
          className="search-replace__toggle"
          onClick={toggleMode}
          title={isReplace ? t("searchPlaceholder") : t("replacePlaceholder")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path
              d={isReplace ? "M11 4L6 8l5 4V4z" : "M4 5l4 5-4 5V5z"}
              fill="currentColor"
            />
          </svg>
        </button>
        <div className="search-replace__fields">
          <div className="search-replace__row">
            <input
              ref={searchInputRef}
              className="search-replace__input"
              type="text"
              placeholder={t("searchPlaceholder")}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              autoFocus
            />
            <span className="search-replace__count">
              {searchText
                ? t("matchCount", {
                    current: matchCount > 0 && currentMatchIndex >= 0 ? (currentMatchIndex % matchCount) + 1 : 0,
                    total: matchCount,
                  })
                : ""}
            </span>
            <button className="search-replace__nav-btn" onClick={goToPrev} disabled={matchCount === 0} title="Shift+F3">
              ↑
            </button>
            <button className="search-replace__nav-btn" onClick={goToNext} disabled={matchCount === 0} title="F3">
              ↓
            </button>
          </div>
          {isReplace && (
            <div className="search-replace__row">
              <input
                ref={replaceInputRef}
                className="search-replace__input"
                type="text"
                placeholder={t("replacePlaceholder")}
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
              />
              <button className="search-replace__btn" onClick={handleReplace} disabled={!searchText}>
                ↓
              </button>
              <button className="search-replace__btn" onClick={handleReplaceAll} disabled={!searchText}>
                {t("replaceAll")}
              </button>
            </div>
          )}
        </div>
      </div>
      <button className="search-replace__close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
