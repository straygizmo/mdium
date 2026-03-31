import { useEffect, useRef, useState, useMemo } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import type { VideoProject } from "../types";

function getMime(src: string): string {
  const ext = src.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    default: return "image/jpeg";
  }
}

function isRemoteOrBlob(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/**
 * Collect all unique local image paths from a VideoProject,
 * load them as blob URLs, and return a project with replaced src values.
 */
export function useImageBlobUrls(project: VideoProject | null): VideoProject | null {
  const [blobMap, setBlobMap] = useState<Record<string, string>>({});
  const blobUrlsRef = useRef<string[]>([]);

  // Collect unique local image paths
  const localPaths = useMemo(() => {
    if (!project) return [];
    const paths = new Set<string>();
    for (const scene of project.scenes) {
      for (const el of scene.elements) {
        if (el.type === "image" && el.enabled !== false && !isRemoteOrBlob(el.src)) {
          paths.add(el.src);
        }
      }
    }
    return Array.from(paths);
  }, [project]);

  useEffect(() => {
    if (localPaths.length === 0) {
      setBlobMap({});
      return;
    }

    let cancelled = false;
    const newBlobUrls: string[] = [];

    (async () => {
      const map: Record<string, string> = {};
      for (const path of localPaths) {
        try {
          const data = await readFile(path);
          const blob = new Blob([data], { type: getMime(path) });
          const url = URL.createObjectURL(blob);
          newBlobUrls.push(url);
          map[path] = url;
        } catch {
          // skip missing files
        }
      }
      if (!cancelled) {
        for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
        blobUrlsRef.current = newBlobUrls;
        setBlobMap(map);
      }
    })();

    return () => { cancelled = true; };
  }, [localPaths]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
    };
  }, []);

  // Return project with replaced image src
  return useMemo(() => {
    if (!project || Object.keys(blobMap).length === 0) return project;
    return {
      ...project,
      scenes: project.scenes.map((scene) => ({
        ...scene,
        elements: scene.elements.map((el) => {
          if (el.type !== "image" || !blobMap[el.src]) return el;
          return { ...el, src: blobMap[el.src] };
        }),
      })),
    };
  }, [project, blobMap]);
}
