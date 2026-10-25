import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKER_ICON_PATHS, markerIcon, outlineDrawing } from "./marker-icons";
import { FALLBACK_ICON, MARKER_COLORS, MARKER_ICONS, markerColorValue, markerLook, projectInitials } from "./project-marker";

const TOKENS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The value `tokens.css` gives to custom property `--name`. */
function token(name: string): string | undefined {
  return new RegExp(`--${name}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "iu").exec(TOKENS)?.[1];
}

/** The hue of `#rrggbb` color `hex`, in degrees from 0 to 360. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return 0;
  const sector = max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return (sector * 60 + 360) % 360;
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

  it("keeps the initials and icons readable on every color, at 4.5:1 at least", () => {
    const ink = token("on-marker");
    expect(ink).toBeDefined();
    for (const color of MARKER_COLORS) {
      const value = token(`marker-${color}`);
      expect(value, color).toBeDefined();
      expect(contrast(value ?? "", ink ?? ""), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("has no amber, orange or yellow color", () => {
    for (const color of MARKER_COLORS) {
      expect(color).not.toMatch(/amber|orange|yellow|gold/u);
      const value = token(`marker-${color}`) ?? "";
      const degrees = hue(value);
      expect(degrees >= 20 && degrees <= 65, `${color} ${value} hue ${String(degrees)}`).toBe(false);
    }
  });

  it("measures hue in degrees", () => {
    expect(hue("#ff0000")).toBe(0);
    expect(hue("#ffbf00")).toBeCloseTo(45, 0);
    expect(hue("#0000ff")).toBe(240);
  });

  it("names each color by its CSS token", () => {
    expect(markerColorValue("blue")).toBe("var(--marker-blue)");
  });

  it("checks contrast as WCAG does", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

describe("markerLook", () => {
  it("shows the initials on the color", () => {
    expect(markerLook("teal", null, "web site")).toEqual({ ground: "var(--marker-teal)", initials: "WS", icon: null });
  });

  it("shows the icon on the color, in the same ink as the initials", () => {
    expect(markerLook("teal", "globe", "web site")).toEqual({ ground: "var(--marker-teal)", initials: "", icon: "globe" });
  });

  it("shows the symbol on the dark ground without a color", () => {
    expect(markerLook(null, "globe", "web site")).toEqual({ ground: null, initials: "", icon: "globe" });
    expect(markerLook(null, null, "web site")).toEqual({ ground: null, initials: "WS", icon: null });
  });

  it("shows the fallback icon for a name without a letter", () => {
    expect(markerLook("teal", null, "2048")).toEqual({ ground: "var(--marker-teal)", initials: "", icon: FALLBACK_ICON });
    expect(markerLook(null, null, "2048")).toEqual({ ground: null, initials: "", icon: FALLBACK_ICON });
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

describe("outline drawings", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (namespace: string, tagName: string) => new FakeSvgElement(namespace, tagName),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws the given path data, with the attributes of a marker icon", () => {
    const drawing = outlineDrawing("M1 1h22") as unknown as FakeSvgElement;
    const icon = markerIcon(FALLBACK_ICON) as unknown as FakeSvgElement;
    expect(drawing.tagName).toBe("svg");
    expect(drawing.namespace).toBe("http://www.w3.org/2000/svg");
    expect(drawing.attributes).toEqual(icon.attributes);
    expect(drawing.classes).toEqual(["marker-icon"]);
    expect(drawing.children.map((child) => [child.tagName, child.attributes])).toEqual([
      ["path", { d: "M1 1h22" }],
    ]);
  });

  it("draws a catalog icon from its path data", () => {
    const icon = markerIcon(FALLBACK_ICON) as unknown as FakeSvgElement;
    expect(icon.children.map((child) => child.attributes)).toEqual([{ d: MARKER_ICON_PATHS[FALLBACK_ICON] }]);
  });

  it("gives an empty drawing for an unknown icon", () => {
    const icon = markerIcon("no-such-icon") as unknown as FakeSvgElement;
    expect(icon.children.map((child) => child.attributes)).toEqual([{ d: "" }]);
  });
});

/** An SVG element that keeps its attributes, classes and children for inspection. */
class FakeSvgElement {
  attributes: Record<string, string> = {};
  classes: string[] = [];
  children: FakeSvgElement[] = [];
  readonly classList = {
    add: (...names: string[]): void => {
      this.classes.push(...names);
    },
  };
  /** Creates an element of tag `tagName` in `namespace`. */
  constructor(
    readonly namespace: string,
    readonly tagName: string,
  ) {}
  /** Sets attribute `name` to `value`. */
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  /** Appends `nodes` as children. */
  append(...nodes: FakeSvgElement[]): void {
    this.children.push(...nodes);
  }
}
