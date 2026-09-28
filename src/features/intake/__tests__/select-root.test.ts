import { describe, expect, it } from "vitest";
import { selectRoot } from "../select-root";

describe("selectRoot", () => {
  it("routes the main window to App", () => {
    expect(selectRoot("")).toEqual({ view: "main" });
    expect(selectRoot("?view=other")).toEqual({ view: "main" });
  });

  it("routes the intake view with its root and intake id", () => {
    expect(selectRoot("?view=intake&root=C%3A%5Cproj&intake=abc")).toEqual({
      view: "intake",
      root: "C:\\proj",
      intakeId: "abc",
      workflowId: null,
    });
  });

  it("treats a missing or empty intake id as a new intake", () => {
    expect(selectRoot("?view=intake&root=%2Fproj")).toEqual({
      view: "intake",
      root: "/proj",
      intakeId: null,
      workflowId: null,
    });
    expect(selectRoot("?view=intake&root=%2Fproj&intake=")).toEqual({
      view: "intake",
      root: "/proj",
      intakeId: null,
      workflowId: null,
    });
  });

  it("carries the workflow the start form preselects", () => {
    expect(selectRoot("?view=intake&root=%2Fproj&intake=&workflow=wf1")).toEqual({
      view: "intake",
      root: "/proj",
      intakeId: null,
      workflowId: "wf1",
    });
  });
});
