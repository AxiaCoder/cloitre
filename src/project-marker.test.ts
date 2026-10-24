import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKER_ICON_PATHS } from "./marker-icons";
import { FALLBACK_ICON, MARKER_COLORS, MARKER_ICONS, projectInitials } from "./project-marker";

const TOKENS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The value `tokens.css` gives to custom property `--name`. */
function token(name: string): string | undefined {
  return new RegExp(`--${name}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "iu").exec(TOKENS)?.[1];
}

/** The WCAG relative luminance of `#rrggbb` color `hex`. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between `#rrggbb` colors `a` and `b`, from 1 to 21. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("projectInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(projectInitials("my-app")).toBe("MA");
    expect(projectInitials("data_pipeline_v2")).toBe("DP");
    expect(projectInitials("web site")).toBe("WS");
  });

  it("takes the first two letters of a single word", () => {
    expect(projectInitials("example")).toBe("EX");
    expect(projectInitials("x")).toBe("X");
  });

  it("ignores leading, trailing and repeated separators", () => {
    expect(projectInitials("_demo--")).toBe("DE");
    expect(projectInitials("--a__b--")).toBe("AB");
  });

  it("skips what is not a letter", () => {
    expect(projectInitials("😀app")).toBe("AP");
    expect(projectInitials("2048-game")).toBe("GA");
    expect(projectInitials("3d-viewer")).toBe("DV");
    expect(projectInitials("@scope/tool")).toBe("SC");
    expect(projectInitials("éclair")).toBe("ÉC");
  });

  it("gives nothing for a name without a letter", () => {
    expect(projectInitials("")).toBe("");
    expect(projectInitials("-_-")).toBe("");
    expect(projectInitials("2048")).toBe("");
    expect(projectInitials("😀🚀")).toBe("");
    expect(projectInitials("#!")).toBe("");
  });
});

describe("marker palette", () => {
  it("has about fifteen colors, each once", () => {
    expect(MARKER_COLORS.length).toBeGreaterThanOrEqual(12);
    expect(MARKER_COLORS.length).toBeLessThanOrEqual(18);
    expect(new Set(MARKER_COLORS).size).toBe(MARKER_COLORS.length);
  });

  it("matches the marker tokens of tokens.css, no more no less", () => {
    const defined = [...TOKENS.matchAll(/--marker-([a-z]+)\s*:\s*#/gu)].map((match) => match[1]);
    expect([...defined].sort()).toEqual([...MARKER_COLORS].sort());
  });

  it("keeps the initials readable on every color, at 4.5:1 at least", () => {
    const ink = token("on-marker");
    expect(ink).toBeDefined();
    for (const color of MARKER_COLORS) {
      const value = token(`marker-${color}`);
      expect(value, color).toBeDefined();
      expect(contrast(value ?? "", ink ?? ""), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("checks contrast as WCAG does", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

describe("marker icons", () => {
  it("draws every icon of the catalog, and no other", () => {
    expect(Object.keys(MARKER_ICON_PATHS).sort()).toEqual([...MARKER_ICONS].sort());
    for (const icon of MARKER_ICONS) {
      expect(MARKER_ICON_PATHS[icon], icon).toMatch(/^M/u);
    }
  });

  it("has the fallback icon in the catalog", () => {
    expect(MARKER_ICONS).toContain(FALLBACK_ICON);
  });
});
