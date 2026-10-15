import { beforeEach, describe, expect, it } from "vitest";
import { useFlowViewStore } from "../flow-store";

const F = "C:/proj";

describe("flow view store navigation stack", () => {
  beforeEach(() => useFlowViewStore.setState({ selected: {}, stack: {} }));

  it("push appends an entry and selects its path", () => {
    const s = useFlowViewStore.getState();
    s.setSelected(F, "a.flow.yaml");
    s.push(F, { path: "a.flow.yaml", label: "A" });
    s.push(F, { path: "parts/b.flow.yaml", label: "b" });
    const next = useFlowViewStore.getState();
    expect(next.stack[F]).toEqual([
      { path: "a.flow.yaml", label: "A" },
      { path: "parts/b.flow.yaml", label: "b" },
    ]);
    expect(next.selected[F]).toBe("parts/b.flow.yaml");
  });

  it("popTo truncates after the index and selects that entry", () => {
    const s = useFlowViewStore.getState();
    s.push(F, { path: "a", label: "A" });
    s.push(F, { path: "b", label: "b" });
    s.push(F, { path: "c", label: "c" });
    s.popTo(F, 1);
    const next = useFlowViewStore.getState();
    expect(next.stack[F]).toEqual([
      { path: "a", label: "A" },
      { path: "b", label: "b" },
    ]);
    expect(next.selected[F]).toBe("b");
  });

  it("reset clears the stack and setSelected resets it", () => {
    const s = useFlowViewStore.getState();
    s.push(F, { path: "a", label: "A" });
    s.push(F, { path: "b", label: "b" });
    s.reset(F);
    expect(useFlowViewStore.getState().stack[F]).toBeUndefined();
    s.push(F, { path: "a", label: "A" });
    s.setSelected(F, "z");
    expect(useFlowViewStore.getState().stack[F]).toBeUndefined();
    expect(useFlowViewStore.getState().selected[F]).toBe("z");
  });
});
