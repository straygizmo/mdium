import { describe, it, expect } from "vitest";
import type { ReplacementRule, ReplacementSettings } from "@/shared/types";
import {
  applyForward,
  applyForwardWithCount,
  applyReverse,
  applyReverseWithCount,
  findDuplicateTos,
} from "../replacement";

function rule(from: string, to: string, enabled = true): ReplacementRule {
  return { id: `${from}->${to}`, from, to, enabled };
}

function settings(rules: ReplacementRule[], enabled = true): ReplacementSettings {
  return { enabled, rules };
}

describe("applyForward", () => {
  it("replaces all occurrences of from with to", () => {
    const s = settings([rule("株式会社A社", "会社X")]);
    expect(applyForward("株式会社A社と株式会社A社の件", s)).toBe("会社Xと会社Xの件");
  });

  it("is a no-op when master toggle is off", () => {
    const s = settings([rule("秘密", "S1")], false);
    expect(applyForward("秘密の話", s)).toBe("秘密の話");
  });

  it("skips disabled rules and rules with empty from/to", () => {
    const s = settings([
      rule("秘密", "S1", false),
      rule("", "X"),
      rule("公開", ""),
    ]);
    expect(applyForward("秘密と公開", s)).toBe("秘密と公開");
  });

  it("applies longer matches first (containment)", () => {
    const s = settings([rule("社名A", "X"), rule("社名A支店", "Y")]);
    expect(applyForward("社名A支店と社名A", s)).toBe("YとX");
  });

  it("does not re-scan replaced output (single pass)", () => {
    // to of rule1 equals from of rule2 — output must not be replaced again
    const s = settings([rule("田中", "社員"), rule("社員", "S")]);
    expect(applyForward("田中と社員", s)).toBe("社員とS");
  });

  it("is case-sensitive and literal", () => {
    const s = settings([rule("Host01", "srv-A")]);
    expect(applyForward("host01 Host01", s)).toBe("host01 srv-A");
  });
});

describe("applyForwardWithCount", () => {
  it("returns the number of replacements", () => {
    const s = settings([rule("秘密", "S1")]);
    expect(applyForwardWithCount("秘密、秘密、公開", s)).toEqual({
      text: "S1、S1、公開",
      count: 2,
    });
  });

  it("returns count 0 for unchanged text", () => {
    const s = settings([rule("秘密", "S1")]);
    expect(applyForwardWithCount("公開情報", s).count).toBe(0);
  });
});

describe("applyReverse", () => {
  it("replaces to back with from", () => {
    const s = settings([rule("株式会社A社", "会社X")]);
    expect(applyReverse("会社Xの担当", s)).toBe("株式会社A社の担当");
  });

  it("round-trips: reverse(forward(x)) === x", () => {
    const s = settings([
      rule("株式会社A社", "会社X"),
      rule("田中太郎", "担当P"),
      rule("hostname01.example.co.jp", "srv-A"),
    ]);
    const original = "田中太郎は株式会社A社のhostname01.example.co.jp を管理。";
    expect(applyReverse(applyForward(original, s), s)).toBe(original);
  });

  it("applies longer to-matches first", () => {
    const s = settings([rule("A社", "X"), rule("A社東京", "X東京支社")]);
    expect(applyReverse("X東京支社とX", s)).toBe("A社東京とA社");
  });
});

describe("applyReverseWithCount", () => {
  it("counts reverse replacements", () => {
    const s = settings([rule("秘密", "S1")]);
    expect(applyReverseWithCount("S1とS1", s)).toEqual({ text: "秘密と秘密", count: 2 });
  });
});

describe("findDuplicateTos", () => {
  it("returns to-values shared by multiple enabled rules", () => {
    const rules = [rule("a", "X"), rule("b", "X"), rule("c", "Y")];
    expect(findDuplicateTos(rules)).toEqual(["X"]);
  });

  it("ignores disabled rules and empty to", () => {
    const rules = [rule("a", "X"), rule("b", "X", false), rule("c", ""), rule("d", "")];
    expect(findDuplicateTos(rules)).toEqual([]);
  });
});
