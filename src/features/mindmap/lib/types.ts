/** KityMinder JSON format types (file format for .km files) */

export interface KityMinderNodeData {
  text: string;
  priority?: number;
  progress?: number;
  hyperlink?: string;
  hyperlinkTitle?: string;
  note?: string;
  image?: string;
  imageSize?: { width: number; height: number };
  expandState?: "expand" | "collapse";
}

export interface KityMinderNode {
  data: KityMinderNodeData;
  children: KityMinderNode[];
}

export interface KityMinderJson {
  root: KityMinderNode;
  template?: string;
  theme?: string;
}

/** Internal node with unique ID for React state management */
export interface MindmapInternalNode {
  id: string;
  data: KityMinderNodeData;
  children: MindmapInternalNode[];
}
