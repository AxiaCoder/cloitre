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

describe("messages.removeTitle", () => {
  it("asks about the project by its name", () => {
    expect(messages.removeTitle("my-app")).toBe("Remove my-app?");
  });
});

describe("messages.removeFailed", () => {
  it("drops the spaces around Rust's reason before its final period", () => {
    expect(messages.removeFailed("  the app data could not be saved. \n")).toBe(
      "The project could not be removed: the app data could not be saved. Nothing has changed. Try again.",
    );
  });

  it("keeps a period inside the reason", () => {
    expect(messages.removeFailed("file a.json is locked")).toBe(
      "The project could not be removed: file a.json is locked. Nothing has changed. Try again.",
    );
  });
});

describe("messages.removeTabs", () => {
  it("counts two tabs in the plural", () => {
    expect(messages.removeTabs(2)).toBe("Its 2 tabs will close and their sessions will stop.");
  });
});

describe("the project menu texts", () => {
  it("name the two grids, the remove entry and the dialog buttons", () => {
    expect([
      texts.markerColors,
      texts.markerSymbols,
      texts.removeProjectEntry,
      texts.cancel,
      texts.confirmRemove,
      texts.folderStays,
    ]).toEqual([
      "Color",
      "Symbol",
      "Remove project…",
      "Cancel",
      "Remove project",
      "The folder stays on disk:",
    ]);
  });
});

describe("the session activity texts", () => {
  it("leave a tab tooltip unchanged without activity", () => {
    expect(messages.tabTitle("Session 1", "running")).toBe("Session 1 (running)");
  });

  it("add what the session is doing to a tab tooltip", () => {
    expect(messages.tabTitle("Session 1", "running", "blocked")).toBe("Session 1 (running, waiting for your answer)");
    expect(messages.tabTitle("Session 1", "running", "done")).toBe("Session 1 (running, finished)");
  });

  it("name a tab label with its activity", () => {
    expect(messages.tabActivityLabel("Session 2", "blocked")).toBe("Session 2, waiting for your answer");
    expect(messages.tabActivityLabel("Session 2", "done")).toBe("Session 2, finished");
  });

  it("say each activity in words", () => {
    expect(messages.activity("blocked")).toBe("waiting for your answer");
    expect(messages.activity("done")).toBe("finished");
    expect(messages.activity("failed")).toBe("stopped on an error");
    expect(messages.activity("working")).toBe("working");
  });

  it("put the activity on its own line under a project tooltip", () => {
    expect(messages.projectStatusTitle("example\n/projects/example", "done")).toBe(
      "example\n/projects/example\nfinished",
    );
    expect(messages.projectStatusTitle("example", "blocked")).toBe("example\nwaiting for your answer");
  });

  it("say a paused project is paused", () => {
    expect(messages.projectStatus("paused")).toBe("Paused");
    expect(messages.projectStatusTitle("example\n/projects/example", "paused")).toBe(
      "example\n/projects/example\nPaused",
    );
  });

  it("say what the sessions of a live project are doing", () => {
    expect(messages.projectStatus("blocked")).toBe("waiting for your answer");
  });

  it("say nothing of a project with no status", () => {
    expect(messages.projectStatus()).toBeUndefined();
    expect(messages.projectStatusTitle("example")).toBe("example");
  });
});
