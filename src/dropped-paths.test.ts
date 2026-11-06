import { describe, expect, it } from "vitest";

import { dropTargetTab, formatPathsForInput, pathStyleOf, quotePath, type DropElement } from "./dropped-paths";

/** Builds an element whose closest `[data-tab]` ancestor carries `value`, or that has none when `value` is `undefined`. */
function elementIn(value: string | undefined): DropElement {
  return {
    closest: (selectors) =>
      value === undefined || selectors !== "[data-tab]" ? null : { getAttribute: () => value },
  };
}

/** Every code point the terminal could act on: C0 controls, DEL, C1 controls, line and paragraph separators. */
const CONTROL_CODE_POINTS = [
  ...Array.from({ length: 0x20 }, (_, code) => code),
  ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
  0x2028,
  0x2029,
];

/** Returns whether `text` holds any of {@link CONTROL_CODE_POINTS}. */
function holdsControl(text: string): boolean {
  for (const character of text) {
    if (CONTROL_CODE_POINTS.includes(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

describe("pathStyleOf", () => {
  it("reads Windows from a WebView2 user agent", () => {
    expect(pathStyleOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0")).toBe("windows");
  });

  it("reads POSIX from a Linux user agent", () => {
    expect(pathStyleOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("posix");
  });

  it("reads POSIX from a macOS user agent", () => {
    expect(pathStyleOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("posix");
  });
});

describe("quotePath on Windows", () => {
  it("keeps a plain path unquoted", () => {
    expect(quotePath("C:\\work\\demo\\notes.md", "windows")).toBe("C:\\work\\demo\\notes.md");
  });

  it("quotes a path with spaces", () => {
    expect(quotePath("C:\\My Files\\a b.txt", "windows")).toBe('"C:\\My Files\\a b.txt"');
  });

  it("quotes a path with accents", () => {
    expect(quotePath("C:\\données\\été.txt", "windows")).toBe('"C:\\données\\été.txt"');
  });

  it("refuses a path holding a double quote", () => {
    expect(quotePath('C:\\a"b.txt', "windows")).toBeUndefined();
  });

  it("treats a folder like any path", () => {
    expect(quotePath("C:\\work\\demo folder", "windows")).toBe('"C:\\work\\demo folder"');
  });
});

describe("quotePath on POSIX", () => {
  it("keeps a plain path unquoted", () => {
    expect(quotePath("/home/user/notes.md", "posix")).toBe("/home/user/notes.md");
  });

  it("quotes a path with spaces", () => {
    expect(quotePath("/home/user/a b.txt", "posix")).toBe("'/home/user/a b.txt'");
  });

  it("escapes a single quote", () => {
    expect(quotePath("/home/user/it's.txt", "posix")).toBe("'/home/user/it'\\''s.txt'");
  });

  it("keeps a double quote inside single quotes", () => {
    expect(quotePath('/home/user/a"b.txt', "posix")).toBe("'/home/user/a\"b.txt'");
  });

  it("quotes a path with accents", () => {
    expect(quotePath("/home/user/été", "posix")).toBe("'/home/user/été'");
  });
});

describe("quotePath refusals", () => {
  it.each([
    ["a line feed", "/tmp/a\nb"],
    ["a carriage return", "/tmp/a\rb"],
    ["a tab", "/tmp/a\tb"],
    ["an escape", "/tmp/a\u001bb"],
    ["DEL", "/tmp/a\u007fb"],
    ["a C1 control", "/tmp/a\u0085b"],
    ["a line separator", "/tmp/a\u2028b"],
    ["a paragraph separator", "/tmp/a\u2029b"],
  ])("refuses a path holding %s", (_name, path) => {
    expect(quotePath(path, "posix")).toBeUndefined();
    expect(quotePath(path, "windows")).toBeUndefined();
  });

  it("refuses an empty path", () => {
    expect(quotePath("", "posix")).toBeUndefined();
    expect(quotePath("", "windows")).toBeUndefined();
  });

  it.each(CONTROL_CODE_POINTS.map((code) => [code.toString(16).padStart(4, "0")]))(
    "refuses a path holding U+%s in both styles",
    (hex) => {
      const path = `/tmp/a${String.fromCodePoint(parseInt(hex, 16))}b`;
      expect(quotePath(path, "posix")).toBeUndefined();
      expect(quotePath(path, "windows")).toBeUndefined();
    },
  );

  it("refuses a control character at either end of the path", () => {
    expect(quotePath("/tmp/a.txt\n", "posix")).toBeUndefined();
    expect(quotePath("\u001b[2J/tmp/a.txt", "posix")).toBeUndefined();
    expect(quotePath("C:\\a.txt\r", "windows")).toBeUndefined();
  });
});

describe("quotePath keeps one path one word", () => {
  it("quotes a POSIX path mixing spaces, accents and both quotes as a single shell word", () => {
    expect(quotePath("/home/user/l'été \"2024\".md", "posix")).toBe("'/home/user/l'\\''été \"2024\".md'");
  });

  it("quotes a Windows path mixing spaces, accents and a single quote as one quoted word", () => {
    expect(quotePath("C:\\Users\\user\\l'été 2024.md", "windows")).toBe("\"C:\\Users\\user\\l'été 2024.md\"");
  });

  it("quotes a Windows path holding a shell character even without a space", () => {
    expect(quotePath("C:\\a&b.txt", "windows")).toBe('"C:\\a&b.txt"');
  });

  it("keeps a Windows drive root unquoted, so no backslash ends a quoted word", () => {
    expect(quotePath("C:\\", "windows")).toBe("C:\\");
  });

  it("quotes a POSIX path holding a shell character even without a space", () => {
    expect(quotePath("/tmp/$HOME;rm", "posix")).toBe("'/tmp/$HOME;rm'");
  });
});

describe("formatPathsForInput", () => {
  it("joins several paths with a space", () => {
    expect(formatPathsForInput(["C:\\a.txt", "C:\\b c.txt"], "windows")).toBe('C:\\a.txt "C:\\b c.txt"');
  });

  it("leaves refused paths out", () => {
    expect(formatPathsForInput(["/a\nb", "/ok.txt"], "posix")).toBe("/ok.txt");
  });

  it("keeps the other paths when a trapped one sits between them", () => {
    expect(formatPathsForInput(["/a b.txt", "/x\u001b[31my", "/c.txt"], "posix")).toBe("'/a b.txt' /c.txt");
    expect(formatPathsForInput(["C:\\a.txt", "C:\\x\ry", "C:\\d e"], "windows")).toBe('C:\\a.txt "C:\\d e"');
    expect(formatPathsForInput(["/a", "/b\u0085c", "/d"], "posix")).toBe("/a /d");
  });

  it("lets no control character reach the input, whatever the paths", () => {
    const trapped = CONTROL_CODE_POINTS.map((code) => `/tmp/a${String.fromCodePoint(code)}b`);
    for (const style of ["posix", "windows"] as const) {
      const input = formatPathsForInput(["/ok one", ...trapped, "/ok-two"], style);
      expect(holdsControl(input)).toBe(false);
      expect(input).not.toBe("");
    }
  });

  it("types a dropped folder as its path", () => {
    expect(formatPathsForInput(["/home/user/my project"], "posix")).toBe("'/home/user/my project'");
  });

  it("returns an empty string when no path is left", () => {
    expect(formatPathsForInput(["/a\nb"], "posix")).toBe("");
    expect(formatPathsForInput([], "posix")).toBe("");
  });
});

describe("dropTargetTab", () => {
  it("returns the tab id carried by the closest marked ancestor", () => {
    expect(dropTargetTab(elementIn("7"))).toBe(7);
  });

  it("returns undefined outside any marked element", () => {
    expect(dropTargetTab(elementIn(undefined))).toBeUndefined();
  });

  it("returns undefined for no element", () => {
    expect(dropTargetTab(null)).toBeUndefined();
  });

  it("returns undefined for a value that is not a whole number", () => {
    expect(dropTargetTab(elementIn(""))).toBeUndefined();
    expect(dropTargetTab(elementIn("1.5"))).toBeUndefined();
  });
});
