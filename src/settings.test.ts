import { describe, expect, it } from "vitest";

import {
  DEFAULT_IDLE_DELAY,
  DEFAULT_KEEP_AWAKE,
  IDLE_DELAY_KEY,
  IDLE_DELAYS,
  idleDelayValue,
  KEEP_AWAKE_CHOICES,
  KEEP_AWAKE_KEY,
  loadIdleDelay,
  loadKeepAwake,
  parseIdleDelay,
  parseKeepAwake,
  saveIdleDelay,
  saveKeepAwake,
  type SettingsStorage,
} from "./settings";

/** Stand-in for local storage: a map of keys to values. */
class FakeStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  /** Returns the value of `key`, or `null` when none is stored. */
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  /** Stores `value` under `key`. */
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

describe("the idle delay setting", () => {
  it("offers Never, then 5, 15 and 30 minutes, 1, 2 and 4 hours", () => {
    expect(IDLE_DELAYS).toEqual(["never", 5, 15, 30, 60, 120, 240]);
  });

  it("defaults to 1 hour", () => {
    expect(DEFAULT_IDLE_DELAY).toBe(60);
    expect(loadIdleDelay(new FakeStorage())).toBe(60);
  });

  it.each(IDLE_DELAYS)("reads back %s once stored", (delay) => {
    const storage = new FakeStorage();
    saveIdleDelay(storage, delay);
    expect(loadIdleDelay(storage)).toBe(delay);
  });

  it("stores the delay under its key", () => {
    const storage = new FakeStorage();
    saveIdleDelay(storage, "never");
    expect(storage.items.get(IDLE_DELAY_KEY)).toBe("never");
  });

  it.each([null, "", "10", "60.0", " 60", "Never", "abc"])("falls back to the default for %j", (value) => {
    expect(parseIdleDelay(value)).toBe(DEFAULT_IDLE_DELAY);
  });

  it("parses every option value back to its delay", () => {
    expect(IDLE_DELAYS.map((delay) => parseIdleDelay(idleDelayValue(delay)))).toEqual(IDLE_DELAYS);
  });
});

describe("the keep-awake setting", () => {
  it("offers Never, while a session works, while a session works or waits", () => {
    expect(KEEP_AWAKE_CHOICES).toEqual(["never", "working", "working-or-blocked"]);
  });

  it("defaults to while a session works or waits", () => {
    expect(DEFAULT_KEEP_AWAKE).toBe("working-or-blocked");
    expect(loadKeepAwake(new FakeStorage())).toBe("working-or-blocked");
  });

  it.each(KEEP_AWAKE_CHOICES)("reads back %s once stored", (choice) => {
    const storage = new FakeStorage();
    saveKeepAwake(storage, choice);
    expect(loadKeepAwake(storage)).toBe(choice);
  });

  it("stores the choice under its key", () => {
    const storage = new FakeStorage();
    saveKeepAwake(storage, "never");
    expect(storage.items.get(KEEP_AWAKE_KEY)).toBe("never");
  });

  it.each([null, "", "Never", "blocked", " working"])("falls back to the default for %j", (value) => {
    expect(parseKeepAwake(value)).toBe(DEFAULT_KEEP_AWAKE);
  });
});
