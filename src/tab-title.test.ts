import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanTitle,
  MAX_TITLE_LENGTH,
  SHOWN_TITLE_LENGTH,
  shortenLabel,
  TITLE_SAVE_DELAY_MS,
  TitleSaver,
} from "./tab-title";

describe("cleanTitle", () => {
  it("keeps a plain title", () => {
    expect(cleanTitle("Fix the parser")).toBe("Fix the parser");
  });

  it("drops control characters and trims", () => {
    expect(cleanTitle(" a\u0007b\u001b[c\u007f\u009bd\n ")).toBe("ab[cd");
  });

  it("drops a right-to-left override that would reverse the title", () => {
    expect(cleanTitle("ab\u202ecd")).toBe("abcd");
  });

  it("drops a zero-width space that would hide part of the title", () => {
    expect(cleanTitle("a\u200bb")).toBe("ab");
  });

  it("returns null for a title made only of invisible format characters", () => {
    expect(cleanTitle("\u202e")).toBeNull();
    expect(cleanTitle(" \u200b\ufeff ")).toBeNull();
  });

  it("drops every invisible format character of the closed list", () => {
    const invisible = [
      0x00ad, 0x061c, 0x180e, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c,
      0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067,
      0x2068, 0x2069, 0xfeff,
    ].map((code) => String.fromCodePoint(code));
    const cleaned = cleanTitle(`a${invisible.join("b")}c`) ?? "";
    expect(invisible.filter((char) => cleaned.includes(char))).toEqual([]);
  });

  it("keeps the zero-width joiners of a composed emoji", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    expect(cleanTitle(`Team ${family}`)).toBe(`Team ${family}`);
    expect(cleanTitle("a\u200cb")).toBe("a\u200cb");
  });

  it("returns null for an empty or blank title", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(" \u0007\t ")).toBeNull();
  });

  it("cuts a title to the longest Rust saves, by code point", () => {
    const cut = cleanTitle("😀".repeat(MAX_TITLE_LENGTH + 10));
    expect(cut === null ? 0 : Array.from(cut).length).toBe(MAX_TITLE_LENGTH);
  });

  it("drops the spaces the cut leaves at the end", () => {
    const raw = `${"a".repeat(MAX_TITLE_LENGTH - 1)} tail`;
    expect(cleanTitle(raw)).toBe("a".repeat(MAX_TITLE_LENGTH - 1));
  });

  it("keeps a title of exactly the longest length whole", () => {
    const longest = "é".repeat(MAX_TITLE_LENGTH);
    expect(cleanTitle(longest)).toBe(longest);
  });

  it("keeps the spaces inside a title", () => {
    expect(cleanTitle("a  b")).toBe("a  b");
  });

  it.each(["✳", "◐", "◑"])("drops the status symbol %s Claude Code puts before the topic", (symbol) => {
    expect(cleanTitle(`${symbol} Fix the parser`)).toBe("Fix the parser");
  });

  it("returns null for a status symbol alone", () => {
    expect(cleanTitle("✳")).toBeNull();
    expect(cleanTitle("◐ ")).toBeNull();
  });

  it("returns null for the names Claude Code sets before it has a topic", () => {
    expect(cleanTitle("claude")).toBeNull();
    expect(cleanTitle("✳ Claude Code")).toBeNull();
    expect(cleanTitle("◐ Claude Code")).toBeNull();
  });

  it("keeps a symbol that is not a leading status symbol", () => {
    expect(cleanTitle("Fix ✳ the parser")).toBe("Fix ✳ the parser");
    expect(cleanTitle("✳Fix")).toBe("✳Fix");
    expect(cleanTitle("● Fix")).toBe("● Fix");
  });

  it("keeps a topic that only starts like Claude Code's name", () => {
    expect(cleanTitle("✳ Claude Code hooks")).toBe("Claude Code hooks");
  });
});

describe("shortenLabel", () => {
  it("keeps a label up to the shown length", () => {
    const fits = "a".repeat(SHOWN_TITLE_LENGTH);
    expect(shortenLabel(fits)).toBe(fits);
  });

  it("cuts a longer label and ends it with an ellipsis", () => {
    const shown = shortenLabel("b".repeat(SHOWN_TITLE_LENGTH + 1));
    expect(shown).toBe(`${"b".repeat(SHOWN_TITLE_LENGTH - 1)}…`);
    expect(Array.from(shown)).toHaveLength(SHOWN_TITLE_LENGTH);
  });

  it("never splits a character made of two code units", () => {
    const shown = shortenLabel("😀".repeat(SHOWN_TITLE_LENGTH + 5));
    expect(shown).toBe(`${"😀".repeat(SHOWN_TITLE_LENGTH - 1)}…`);
  });

  it("puts the ellipsis right after the last word, not after a space", () => {
    const text = `${"c".repeat(SHOWN_TITLE_LENGTH - 2)} ${"d".repeat(10)}`;
    expect(shortenLabel(text)).toBe(`${"c".repeat(SHOWN_TITLE_LENGTH - 2)}…`);
  });

  it("keeps the Session N fallback as it is", () => {
    expect(shortenLabel("Session 12")).toBe("Session 12");
  });
});

describe("TitleSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A saver whose saves and errors are recorded. */
  function recordingSaver() {
    const saves: [number, string | null][] = [];
    const errors: [number, unknown][] = [];
    const save = vi.fn((tabId: number, title: string | null) => {
      saves.push([tabId, title]);
      return Promise.resolve();
    });
    const saver = new TitleSaver(save, (tabId, error) => errors.push([tabId, error]));
    return { saver, saves, errors, save };
  }

  it("saves a title once it stays unchanged for the delay", () => {
    const { saver, saves } = recordingSaver();
    saver.schedule(1, "Title");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS - 1);
    expect(saves).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saves).toEqual([[1, "Title"]]);
  });

  it("saves only the last of many quick changes", () => {
    const { saver, saves } = recordingSaver();
    for (let frame = 0; frame < 50; frame += 1) {
      saver.schedule(1, `${String(frame % 4)} Working`);
      vi.advanceTimersByTime(100);
    }
    saver.schedule(1, "Done");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(saves).toEqual([[1, "Done"]]);
  });

  it("saves nothing when the title is the last one saved", () => {
    const { saver, saves } = recordingSaver();
    saver.markSaved(1, "Restored");
    saver.schedule(1, "Restored");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    saver.schedule(2, null);
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(saves).toEqual([]);
    saver.schedule(1, "Other");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    saver.schedule(1, "Other");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(saves).toEqual([[1, "Other"]]);
  });

  it("keeps each tab's delay apart", () => {
    const { saver, saves } = recordingSaver();
    saver.schedule(1, "One");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS / 2);
    saver.schedule(2, "Two");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS / 2);
    expect(saves).toEqual([[1, "One"]]);
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS / 2);
    expect(saves).toEqual([
      [1, "One"],
      [2, "Two"],
    ]);
  });

  it("drops the pending save of a forgotten tab", () => {
    const { saver, saves } = recordingSaver();
    saver.schedule(1, "Closing");
    saver.forget(1);
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(saves).toEqual([]);
  });

  it("reports a failed save and tries the same title again at the next change", async () => {
    const { saver, errors, save } = recordingSaver();
    save.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    saver.schedule(1, "Title");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    await vi.runAllTimersAsync();
    expect(errors).toEqual([[1, new Error("disk full")]]);
    saver.schedule(1, "Title");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer saved title when an older save fails afterwards", async () => {
    const { saver, errors, save } = recordingSaver();
    let failFirst: (error: Error) => void = () => undefined;
    save.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          failFirst = reject;
        }),
    );
    saver.schedule(1, "Old");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    saver.schedule(1, "New");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    failFirst(new Error("disk full"));
    await vi.runAllTimersAsync();
    expect(errors).toEqual([[1, new Error("disk full")]]);
    saver.schedule(1, "New");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("saves a title cleared to null after one was saved", () => {
    const { saver, saves } = recordingSaver();
    saver.markSaved(1, "Restored");
    saver.schedule(1, null);
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(saves).toEqual([[1, null]]);
  });

  it("saves again a reopened tab's title once the tab was forgotten", () => {
    const { saver, saves } = recordingSaver();
    saver.markSaved(1, "Kept");
    saver.forget(1);
    saver.schedule(1, "Kept");
    vi.advanceTimersByTime(TITLE_SAVE_DELAY_MS);
    expect(saves).toEqual([[1, "Kept"]]);
  });

  it("waits for the delay it was given", () => {
    const saves: string[] = [];
    const saver = new TitleSaver(
      (_, title) => {
        saves.push(title ?? "");
        return Promise.resolve();
      },
      () => undefined,
      50,
    );
    saver.schedule(1, "Quick");
    vi.advanceTimersByTime(49);
    expect(saves).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saves).toEqual(["Quick"]);
  });
});
