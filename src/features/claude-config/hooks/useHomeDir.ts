import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Home directory reported by the backend, or "" until it resolves. */
export function useHomeDir(): string {
  const [home, setHome] = useState("");
  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_home_dir")
      .then((h) => {
        if (!cancelled) setHome(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return home;
}
