import { useState, useCallback, useRef, useEffect } from "react";
import { getOpencodeClient } from "./useOpencodeChat";

export interface CompletionItem {
  type: "command" | "agent" | "file";
  label: string;
  description?: string;
  value: string;
}

type CompletionMode = "command" | "mention" | null;

interface CompletionState {
  visible: boolean;
  items: CompletionItem[];
  selectedIndex: number;
  mode: CompletionMode;
  triggerPos: number;
}

const INITIAL_STATE: CompletionState = {
  visible: false,
  items: [],
  selectedIndex: 0,
  mode: null,
  triggerPos: -1,
};

const MAX_ITEMS = 10;
const FILE_SEARCH_DEBOUNCE = 300;

interface UseCompletionOptions {
  connected: boolean;
  input: string;
  folderPath?: string;
  onInputChange: (value: string) => void;
  onCommandSelect: (name: string, args?: string) => void;
  onAgentSelect: (agent: string) => void;
}

export function useCompletion(options: UseCompletionOptions) {
  const { connected, input, folderPath, onInputChange, onCommandSelect, onAgentSelect } = options;

  const [state, setState] = useState<CompletionState>(INITIAL_STATE);
  const commandsCacheRef = useRef<CompletionItem[]>([]);
  const agentsCacheRef = useRef<CompletionItem[]>([]);
  const fileSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileResultsRef = useRef<CompletionItem[]>([]);

  // Fetch commands and agents when connected
  useEffect(() => {
    if (!connected) return;
    const client = getOpencodeClient();
    if (!client) return;

    client.command.list().then((res) => {
      const cmds = (res.data as any) ?? [];
      commandsCacheRef.current = (Array.isArray(cmds) ? cmds : []).map((c: any) => ({
        type: "command" as const,
        label: c.name,
        description: c.description ?? c.template,
        value: c.name,
      }));
    }).catch(() => {});

    client.app.agents().then((res) => {
      const agents = (res.data as any) ?? [];
      agentsCacheRef.current = (Array.isArray(agents) ? agents : []).map((a: any) => ({
        type: "agent" as const,
        label: a.name,
        description: a.description,
        value: a.name,
      }));
    }).catch(() => {});
  }, [connected]);

  // Detect triggers and update completion state when input changes
  useEffect(() => {
    const trimmed = input;

    // Command mode: input starts with "/"
    if (trimmed.startsWith("/")) {
      const query = trimmed.slice(1).toLowerCase();
      const filtered = commandsCacheRef.current
        .filter((c) => c.label.toLowerCase().includes(query))
        .slice(0, MAX_ITEMS);
      setState({
        visible: filtered.length > 0,
        items: filtered,
        selectedIndex: 0,
        mode: "command",
        triggerPos: 0,
      });
      return;
    }

    // Mention mode: find last "@" preceded by start or whitespace
    const mentionMatch = findMentionTrigger(trimmed);
    console.log("[completion] input:", JSON.stringify(trimmed), "mentionMatch:", mentionMatch);
    if (mentionMatch !== null) {
      const query = trimmed.slice(mentionMatch + 1).toLowerCase();

      // Filter agents
      const filteredAgents = agentsCacheRef.current
        .filter((a) => a.label.toLowerCase().includes(query))
        .slice(0, MAX_ITEMS);
      console.log("[completion] query:", JSON.stringify(query), "agentsCache:", agentsCacheRef.current.length, "filteredAgents:", filteredAgents.length);

      // Combine agents + any cached file results
      const filteredFiles = fileResultsRef.current
        .filter((f) => f.label.toLowerCase().includes(query))
        .slice(0, MAX_ITEMS - filteredAgents.length);

      const combined = [...filteredAgents, ...filteredFiles];
      console.log("[completion] combined:", combined.length, "visible:", combined.length > 0);
      setState({
        visible: combined.length > 0,
        items: combined,
        selectedIndex: 0,
        mode: "mention",
        triggerPos: mentionMatch,
      });

      // Debounced file search
      if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current);
      if (query.length >= 1) {
        fileSearchTimerRef.current = setTimeout(() => {
          searchFiles(query, folderPath).then((files) => {
            fileResultsRef.current = files;
            // Re-filter and update
            setState((prev) => {
              if (prev.mode !== "mention") return prev;
              const currentQuery = input.slice(prev.triggerPos + 1).toLowerCase();
              const agents = agentsCacheRef.current
                .filter((a) => a.label.toLowerCase().includes(currentQuery))
                .slice(0, MAX_ITEMS);
              const fileItems = files
                .filter((f) => f.label.toLowerCase().includes(currentQuery))
                .slice(0, MAX_ITEMS - agents.length);
              const items = [...agents, ...fileItems];
              return {
                ...prev,
                items,
                visible: items.length > 0,
                selectedIndex: Math.min(prev.selectedIndex, Math.max(0, items.length - 1)),
              };
            });
          });
        }, FILE_SEARCH_DEBOUNCE);
      }
      return;
    }

    // No trigger active
    if (state.visible) {
      setState(INITIAL_STATE);
    }
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    setState(INITIAL_STATE);
    fileResultsRef.current = [];
  }, []);

  // Handle keyboard navigation. Returns true if the key was consumed.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!state.visible) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setState((prev) => ({
          ...prev,
          selectedIndex: Math.min(prev.selectedIndex + 1, prev.items.length - 1),
        }));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setState((prev) => ({
          ...prev,
          selectedIndex: Math.max(prev.selectedIndex - 1, 0),
        }));
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const item = state.items[state.selectedIndex];
        if (item) selectItem(item);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [state.visible, state.items, state.selectedIndex, close] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const selectItem = useCallback(
    (item: CompletionItem) => {
      if (item.type === "command") {
        onCommandSelect(item.value);
        onInputChange("");
      } else if (item.type === "agent") {
        onAgentSelect(item.value);
        // Replace from trigger position to end with @agentName + space
        const before = input.slice(0, state.triggerPos);
        onInputChange(`${before}@${item.value} `);
      } else if (item.type === "file") {
        // Insert file path
        const before = input.slice(0, state.triggerPos);
        onInputChange(`${before}@${item.value} `);
      }
      close();
    },
    [input, state.triggerPos, onCommandSelect, onAgentSelect, onInputChange, close]
  );

  const handleItemClick = useCallback(
    (index: number) => {
      const item = state.items[index];
      if (item) selectItem(item);
    },
    [state.items, selectItem]
  );

  return {
    visible: state.visible,
    items: state.items,
    selectedIndex: state.selectedIndex,
    mode: state.mode,
    handleKeyDown,
    handleItemClick,
    close,
  };
}

/** Find the position of the last "@" that is at the start or preceded by whitespace */
function findMentionTrigger(input: string): number | null {
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i] === " " || input[i] === "\n") {
      // Hit whitespace before finding @, no active trigger
      return null;
    }
    if (input[i] === "@") {
      if (i === 0 || input[i - 1] === " " || input[i - 1] === "\n") {
        return i;
      }
      return null;
    }
  }
  return null;
}

async function searchFiles(query: string, directory?: string): Promise<CompletionItem[]> {
  const client = getOpencodeClient();
  if (!client || !query) return [];

  try {
    const res = await client.find.files({
      query: { query, dirs: "true", ...(directory ? { directory } : {}) },
    });
    const paths = (res.data as any) ?? [];
    if (!Array.isArray(paths)) return [];
    return paths.slice(0, 20).map((p: string) => ({
      type: "file" as const,
      label: p,
      description: undefined,
      value: p,
    }));
  } catch {
    return [];
  }
}
