import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fillTexts, isTextKey, messages, texts, type TextTarget } from "./strings";

/** Stand-in for an element: its text content and its attributes. */
class FakeTarget implements TextTarget {
  textContent: string | null = "";
  /** Creates an element with `attributes`. */
  constructor(readonly attributes: Record<string, string>) {}
  /** Returns attribute `name`, or `null` when it is not set. */
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  /** Sets attribute `name`. */
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

/** A page made of `targets`, searched as `fillTexts` searches it; keeps the selectors asked for. */
function page(targets: FakeTarget[]) {
  const asked: string[] = [];
  return {
    asked,
    querySelectorAll: (selectors: string) => {
      asked.push(selectors);
      return targets;
    },
  };
}

describe("fillTexts", () => {
  it("fills the text, the accessible name and the tooltip each element names", () => {
    const button = new FakeTarget({ "data-text": "mark", "data-title": "markTitle" });
    const nav = new FakeTarget({ "data-label": "projects" });
    const root = page([button, nav]);
    fillTexts(root);
    expect(root.asked).toEqual(["[data-text],[data-label],[data-title]"]);
    expect(button.textContent).toBe("Mark");
    expect(button.attributes.title).toBe("Mark the recording (F9)");
    expect(nav.textContent).toBe("");
    expect(nav.attributes["aria-label"]).toBe("Projects");
  });

  it("refuses a key no text has", () => {
    expect(() => {
      fillTexts(page([new FakeTarget({ "data-text": "nope" })]));
    }).toThrow('unknown text key "nope" in data-text');
  });
});

describe("isTextKey", () => {
  it("knows the keys of the fixed texts, not the object's inherited names", () => {
    expect(isTextKey("tryAgain")).toBe(true);
    expect(isTextKey("toString")).toBe(false);
    expect(texts.tryAgain).toBe("Try again");
  });
});

describe("index.html", () => {
  it("names only keys the fixed texts have", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const named = [...html.matchAll(/data-(?:text|label|title)="([^"]*)"/gu)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((key) => !isTextKey(key))).toEqual([]);
  });
});

describe("messages.sessionCount", () => {
  it("says session for one and sessions otherwise", () => {
    expect(messages.sessionCount(0)).toBe("0 sessions");
    expect(messages.sessionCount(1)).toBe("1 session");
    expect(messages.sessionCount(2)).toBe("2 sessions");
  });
});
