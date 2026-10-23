import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKER_COUNT, markerIndex, projectInitials } from "./project-marker";

describe("projectInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(projectInitials("my-app")).toBe("MA");
    expect(projectInitials("data_pipeline_v2")).toBe("DP");
    expect(projectInitials("web site")).toBe("WS");
  });

  it("takes the first two characters of a single word", () => {
    expect(projectInitials("example")).toBe("EX");
    expect(projectInitials("x")).toBe("X");
  });

  it("ignores leading, trailing and repeated separators", () => {
    expect(projectInitials("_demo--")).toBe("DE");
    expect(projectInitials("--a__b--")).toBe("AB");
  });

  it("keeps a character outside the basic plane whole", () => {
    expect(projectInitials("😀app")).toBe("😀A");
  });

  it("gives nothing for an empty name", () => {
    expect(projectInitials("")).toBe("");
    expect(projectInitials("-_-")).toBe("");
  });
});

describe("markerIndex", () => {
  it("walks the palette from 1 and wraps around", () => {
    expect(markerIndex(1)).toBe(1);
    expect(markerIndex(MARKER_COUNT)).toBe(MARKER_COUNT);
    expect(markerIndex(MARKER_COUNT + 1)).toBe(1);
  });

  it("stays in the palette for any id", () => {
    for (const id of [0, -3, 1_000_003]) {
      const index = markerIndex(id);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(MARKER_COUNT);
    }
  });

  it("matches the palette tokens.css defines", () => {
    const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
    const defined = [...tokens.matchAll(/--marker-(\d+)\s*:/gu)].map((match) => Number(match[1]));
    expect(defined.sort((a, b) => a - b)).toEqual(Array.from({ length: MARKER_COUNT }, (_, i) => i + 1));
  });
});
