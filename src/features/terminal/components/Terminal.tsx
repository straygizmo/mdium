import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

interface TerminalProps {
  id: string;
  folderPath: string;
  themeType: "light" | "dark";
  command?: string;
  active?: boolean;
}

const DARK_THEME = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  selectionBackground: "#45475a80",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
};

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1f2937",
  cursor: "#1f2937",
  selectionBackground: "#e9d5ff80",
  black: "#1f2937",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#f3f4f6",
};

export function Terminal({ id, folderPath, themeType, command, active = true }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const theme = themeType === "dark" ? DARK_THEME : LIGHT_THEME;
    const xterm = new XTerm({
      fontFamily: '"Cascadia Code", "Consolas", monospace',
      fontSize: 13,
      theme,
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());
    xterm.loadAddon(new Unicode11Addon());
    xterm.unicode.activeVersion = "11";

    xterm.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        // Listen BEFORE spawning so we never miss the initial prompt
        unlisten = await listen<string>(`pty-output-${id}`, (event) => {
          xterm.write(event.payload);
        });

        await invoke("spawn_pty", {
          id,
          cwd: folderPath,
          cols: xterm.cols,
          rows: xterm.rows,
          command: command ?? null,
        });

        xterm.onData((data) => {
          invoke("write_to_pty", { id, data }).catch(() => {});
        });

        if (active) {
          xterm.focus();
        }
      } catch (e) {
        xterm.writeln(`\r\n[Terminal error: ${e}]`);
      }
    };

    setup();

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      invoke("resize_pty", { id, cols: xterm.cols, rows: xterm.rows }).catch(() => {});
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      unlisten?.();
      xterm.dispose();
      invoke("kill_pty", { id }).catch(() => {});
    };
  // folderPath is intentionally excluded: each Terminal instance is rendered
  // per-folder with a unique key, so folderPath never changes during its lifetime.
  // Including it would kill & respawn PTY processes on folder tab switches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, themeType, command]);

  // Re-fit and focus when the tab becomes active (display: none → flex)
  useEffect(() => {
    if (active && fitAddonRef.current && xtermRef.current) {
      // Delay slightly so the container has layout dimensions
      const timer = setTimeout(() => {
        fitAddonRef.current?.fit();
        const xterm = xtermRef.current;
        if (xterm) {
          invoke("resize_pty", { id, cols: xterm.cols, rows: xterm.rows }).catch(() => {});
          xterm.focus();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [active, id]);

  // Focus terminal when the container is clicked
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleClick = () => xtermRef.current?.focus();
    container.addEventListener("mousedown", handleClick);
    return () => container.removeEventListener("mousedown", handleClick);
  }, []);

  const bg = themeType === "dark" ? DARK_THEME.background : LIGHT_THEME.background;
  return <div className="terminal" ref={containerRef} style={{ background: bg }} />;
}
