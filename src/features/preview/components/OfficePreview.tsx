import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./OfficePreview.css";

interface OfficePreviewProps {
  fileData: Uint8Array;
  fileType: string;
  themeType: "light" | "dark";
}

export function OfficePreview({ fileData, fileType, themeType }: OfficePreviewProps) {
  const { t } = useTranslation("common");
  const containerRef = useRef<HTMLDivElement>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [sheetHtml, setSheetHtml] = useState("");
  const [error, setError] = useState<string | null>(null);

  // .docx rendering
  useEffect(() => {
    if (fileType !== ".docx") return;
    const container = containerRef.current;
    if (!container || !fileData) return;

    let cancelled = false;
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
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [fileData, fileType]);

  // .xlsx / .xlsm rendering
  useEffect(() => {
    if (fileType !== ".xlsx" && fileType !== ".xlsm") return;
    if (!fileData) return;

    let cancelled = false;
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
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [fileData, fileType]);

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
        <div className="office-preview__error">{t("error")}: {error}</div>
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
