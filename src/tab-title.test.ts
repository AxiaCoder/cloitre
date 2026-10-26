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

  it("returns null for an empty or blank title", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(" \u0007\t ")).toBeNull();
  });

  it("cuts a title to the longest Rust saves, by code point", () => {
    const cut = cleanTitle("😀".repeat(MAX_TITLE_LENGTH + 10));
    expect(cut === null ? 0 : Array.from(cut).length).toBe(MAX_TITLE_LENGTH);
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
});
