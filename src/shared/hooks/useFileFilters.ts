import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { FileEntry } from "@/shared/types";
import { useFolderWatcher } from "./useFolderWatcher";

export function useFileFilters(folderPath: string | null, setFileTree: (folderPath: string, entries: FileEntry[]) => void, isZennMode = false) {
  const migrateOld = localStorage.getItem("md-office-viewer") === "true";

  const [showAll, setShowAll] = useState(
    () => localStorage.getItem("md-filter-show-all") !== "false"
  );

  const [filterDocx, setFilterDocx] = useState(
    () => localStorage.getItem("md-filter-docx") !== null
      ? localStorage.getItem("md-filter-docx") === "true"
      : migrateOld
  );
  const [filterXls, setFilterXls] = useState(
    () => localStorage.getItem("md-filter-xls") !== null
      ? localStorage.getItem("md-filter-xls") === "true"
      : migrateOld
  );
  const [filterKm, setFilterKm] = useState(
    () => localStorage.getItem("md-filter-km") === "true"
  );
  const [filterImages, setFilterImages] = useState(
    () => localStorage.getItem("md-filter-images") === "true"
  );
  const [filterPdf, setFilterPdf] = useState(
    () => localStorage.getItem("md-filter-pdf") === "true"
  );

  const [showDocxBtn, setShowDocxBtn] = useState(
    () => localStorage.getItem("md-show-docx-btn") !== "false"
  );
  const [showXlsBtn, setShowXlsBtn] = useState(
    () => localStorage.getItem("md-show-xls-btn") !== "false"
  );
  const [showKmBtn, setShowKmBtn] = useState(
    () => localStorage.getItem("md-show-km-btn") === "true"
  );
  const [showImagesBtn, setShowImagesBtn] = useState(
    () => localStorage.getItem("md-show-images-btn") === "true"
  );
  const [showPdfBtn, setShowPdfBtn] = useState(
    () => localStorage.getItem("md-show-pdf-btn") === "true"
  );

  const handleSaveFilterVisibility = useCallback((v: { showDocx: boolean; showXls: boolean; showKm: boolean; showImages: boolean; showPdf: boolean }) => {
    setShowDocxBtn(v.showDocx);
    setShowXlsBtn(v.showXls);
    setShowKmBtn(v.showKm);
    setShowImagesBtn(v.showImages);
    setShowPdfBtn(v.showPdf);
    localStorage.setItem("md-show-docx-btn", String(v.showDocx));
    localStorage.setItem("md-show-xls-btn", String(v.showXls));
    localStorage.setItem("md-show-km-btn", String(v.showKm));
    localStorage.setItem("md-show-images-btn", String(v.showImages));
    localStorage.setItem("md-show-pdf-btn", String(v.showPdf));
    if (!v.showDocx && filterDocx) {
      setFilterDocx(false);
      localStorage.setItem("md-filter-docx", "false");
    }
    if (!v.showXls && filterXls) {
      setFilterXls(false);
      localStorage.setItem("md-filter-xls", "false");
    }
    if (!v.showKm && filterKm) {
      setFilterKm(false);
      localStorage.setItem("md-filter-km", "false");
    }
    if (!v.showImages && filterImages) {
      setFilterImages(false);
      localStorage.setItem("md-filter-images", "false");
    }
    if (!v.showPdf && filterPdf) {
      setFilterPdf(false);
      localStorage.setItem("md-filter-pdf", "false");
    }
  }, [filterDocx, filterXls, filterKm, filterImages, filterPdf]);

  const activateShowAll = useCallback(() => {
    setShowAll(true);
    localStorage.setItem("md-filter-show-all", "true");
    setFilterDocx(false);
    setFilterXls(false);
    setFilterKm(false);
    setFilterImages(false);
    setFilterPdf(false);
    localStorage.setItem("md-filter-docx", "false");
    localStorage.setItem("md-filter-xls", "false");
    localStorage.setItem("md-filter-km", "false");
    localStorage.setItem("md-filter-images", "false");
    localStorage.setItem("md-filter-pdf", "false");
  }, []);

  const makeToggle = useCallback((
    setter: React.Dispatch<React.SetStateAction<boolean>>,
    key: string,
    otherFilters: boolean[],
  ) => () => {
    setter((prev) => {
      const next = !prev;
      localStorage.setItem(key, String(next));
      if (!next && otherFilters.every((f) => !f)) {
        setShowAll(true);
        localStorage.setItem("md-filter-show-all", "true");
      } else {
        setShowAll(false);
        localStorage.setItem("md-filter-show-all", "false");
      }
      return next;
    });
  }, []);

  const toggleFilterDocx = useCallback(() => {
    makeToggle(setFilterDocx, "md-filter-docx", [filterXls, filterKm, filterImages, filterPdf])();
  }, [makeToggle, filterXls, filterKm, filterImages, filterPdf]);

  const toggleFilterXls = useCallback(() => {
    makeToggle(setFilterXls, "md-filter-xls", [filterDocx, filterKm, filterImages, filterPdf])();
  }, [makeToggle, filterDocx, filterKm, filterImages, filterPdf]);

  const toggleFilterKm = useCallback(() => {
    makeToggle(setFilterKm, "md-filter-km", [filterDocx, filterXls, filterImages, filterPdf])();
  }, [makeToggle, filterDocx, filterXls, filterImages, filterPdf]);

  const toggleFilterImages = useCallback(() => {
    makeToggle(setFilterImages, "md-filter-images", [filterDocx, filterXls, filterKm, filterPdf])();
  }, [makeToggle, filterDocx, filterXls, filterKm, filterPdf]);

  const toggleFilterPdf = useCallback(() => {
    makeToggle(setFilterPdf, "md-filter-pdf", [filterDocx, filterXls, filterKm, filterImages])();
  }, [makeToggle, filterDocx, filterXls, filterKm, filterImages]);

  useEffect(() => {
    if (!folderPath) return;
    let cancelled = false;
    const fp = folderPath;
    (async () => {
      try {
        const entries: FileEntry[] = await invoke("get_file_tree", {
          path: fp,
          showAll: isZennMode ? false : showAll,
          includeDocx: isZennMode ? false : filterDocx,
          includeXls: isZennMode ? false : filterXls,
          includeKm: isZennMode ? false : filterKm,
          includeImages: isZennMode ? true : filterImages,
          includePdf: isZennMode ? false : filterPdf,
          includeEmptyDirs: true,
        });
        if (!cancelled) setFileTree(fp, entries);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [showAll, filterDocx, filterXls, filterKm, filterImages, filterPdf, folderPath, setFileTree, isZennMode]);

  const refreshFileTree = useCallback(async () => {
    if (!folderPath) return;
    try {
      const entries: FileEntry[] = await invoke("get_file_tree", {
        path: folderPath,
        showAll: isZennMode ? false : showAll,
        includeDocx: isZennMode ? false : filterDocx,
        includeXls: isZennMode ? false : filterXls,
        includeKm: isZennMode ? false : filterKm,
        includeImages: isZennMode ? true : filterImages,
        includePdf: isZennMode ? false : filterPdf,
        includeEmptyDirs: true,
      });
      setFileTree(folderPath, entries);
    } catch { /* ignore */ }
  }, [folderPath, showAll, filterDocx, filterXls, filterKm, filterImages, filterPdf, setFileTree, isZennMode]);

  // Auto-refresh file tree when folder contents change on disk
  useFolderWatcher(folderPath, refreshFileTree);

  return {
    showAll, activateShowAll,
    filterDocx, filterXls, filterKm, filterImages, filterPdf,
    toggleFilterDocx, toggleFilterXls, toggleFilterKm, toggleFilterImages, toggleFilterPdf,
    showDocxBtn, showXlsBtn, showKmBtn, showImagesBtn, showPdfBtn,
    handleSaveFilterVisibility,
    refreshFileTree,
  } as const;
}
