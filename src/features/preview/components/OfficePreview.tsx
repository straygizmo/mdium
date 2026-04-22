import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./OfficePreview.css";

interface OfficePreviewProps {
  fileData: Uint8Array;
  fileType: string;
  themeType: "light" | "dark";
}

const AUTO_RETRY_DELAY_MS = 200;

export function OfficePreview({ fileData, fileType, themeType }: OfficePreviewProps) {
  const { t } = useTranslation("common");
  const containerRef = useRef<HTMLDivElement>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [sheetHtml, setSheetHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const autoRetriedRef = useRef(false);

  // Reset auto-retry budget when the source file changes
  useEffect(() => {
    autoRetriedRef.current = false;
  }, [fileData, fileType]);

  const handleManualRetry = () => {
    autoRetriedRef.current = false;
    setError(null);
    setRetryKey((k) => k + 1);
  };

  // .docx rendering
  useEffect(() => {
    if (fileType !== ".docx") return;
    const container = containerRef.current;
    if (!container || !fileData) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        container.innerHTML = "";
        await renderAsync(fileData.buffer, container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true,
          ignoreFonts: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        setError(null);
      } catch (e) {
        if (cancelled) return;
        if (!autoRetriedRef.current) {
          autoRetriedRef.current = true;
          retryTimer = setTimeout(() => {
            if (!cancelled) setRetryKey((k) => k + 1);
          }, AUTO_RETRY_DELAY_MS);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [fileData, fileType, retryKey]);

  // .xlsx / .xlsm rendering
  useEffect(() => {
    if (fileType !== ".xlsx" && fileType !== ".xlsm" && fileType !== ".xlam") return;
    if (!fileData) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        if (cancelled) return;
        const workbook = XLSX.read(fileData, { type: "array" });
        setSheets(workbook.SheetNames);
        setActiveSheet(0);

        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (sheet) {
          setSheetHtml(XLSX.utils.sheet_to_html(sheet, { editable: false }));
        }
        setError(null);
      } catch (e) {
        if (cancelled) return;
        if (!autoRetriedRef.current) {
          autoRetriedRef.current = true;
          retryTimer = setTimeout(() => {
            if (!cancelled) setRetryKey((k) => k + 1);
          }, AUTO_RETRY_DELAY_MS);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [fileData, fileType, retryKey]);

  // Sheet tab switch
  const handleSheetChange = async (index: number) => {
    setActiveSheet(index);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(fileData, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[index]];
      if (sheet) {
        setSheetHtml(XLSX.utils.sheet_to_html(sheet, { editable: false }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error) {
    return (
      <div className={`office-preview office-preview--${themeType}`}>
        <div className="office-preview__error">
          <div className="office-preview__error-message">{t("error")}: {error}</div>
          <button
            type="button"
            className="office-preview__retry-btn"
            onClick={handleManualRetry}
          >
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  if (fileType === ".pdf") {
    const blob = new Blob([new Uint8Array(fileData)], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    return (
      <div className={`office-preview office-preview--${themeType}`} style={{ height: "100%" }}>
        <iframe
          src={url}
          style={{ width: "100%", height: "100%", border: "none" }}
          title="PDF Preview"
        />
      </div>
    );
  }

  if (fileType === ".docx") {
    return (
      <div className={`office-preview office-preview--${themeType}`}>
        <div ref={containerRef} className="office-preview__docx-container" />
      </div>
    );
  }

  // xlsx / xlsm
  return (
    <div className={`office-preview office-preview--${themeType}`}>
      {sheets.length > 1 && (
        <div className="office-preview__tabs">
          {sheets.map((name, i) => (
            <button
              key={name}
              className={`office-preview__sheet-tab ${i === activeSheet ? "office-preview__sheet-tab--active" : ""}`}
              onClick={() => handleSheetChange(i)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div
        className="office-preview__xlsx-container"
        dangerouslySetInnerHTML={{ __html: sheetHtml }}
      />
    </div>
  );
}
