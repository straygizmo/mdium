/**
 * Bidirectional mapping between mdium mindmap layouts and XMind structureClass
 * identifiers. Shared by the serializer (write) and parser (read) so layout
 * round-trips through .xmind and also renders correctly in XMind.
 */

/** mdium layout -> XMind structureClass */
const LAYOUT_TO_STRUCTURE: Record<string, string> = {
  right: "org.xmind.ui.logic.right",
  left: "org.xmind.ui.logic.left",
  mind: "org.xmind.ui.map.unbalanced",
  bottom: "org.xmind.ui.org-chart.down",
  filetree: "org.xmind.ui.tree.right",
};

export function layoutToStructure(layout: string): string {
  return LAYOUT_TO_STRUCTURE[layout] ?? "org.xmind.ui.logic.right";
}

/** XMind structureClass -> mdium layout (prefix-based, tolerant of variants) */
export function structureToLayout(structureClass: string | undefined): string {
  if (!structureClass) return "right";
  const s = structureClass;
  if (s.startsWith("org.xmind.ui.logic.left")) return "left";
  if (s.startsWith("org.xmind.ui.logic.right")) return "right";
  if (s.startsWith("org.xmind.ui.map")) return "mind";
  if (s.startsWith("org.xmind.ui.org-chart")) return "bottom";
  if (s.startsWith("org.xmind.ui.tree")) return "filetree";
  return "right";
}
