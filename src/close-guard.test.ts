import { describe, expect, it } from "vitest";

import { CLOSE_GUARD_DELAY_MS, CloseGuard } from "./close-guard";

describe("CloseGuard", () => {
  it("accepts the first close click", () => {
    expect(new CloseGuard().accept(1000)).toBe(true);
  });

  it("ignores a second click just under the delay after a close", () => {
    const guard = new CloseGuard();
    guard.accept(1000);

    expect(guard.accept(1000 + CLOSE_GUARD_DELAY_MS - 1)).toBe(false);
  });

  it("accepts a second click once the delay after a close has passed", () => {
    const guard = new CloseGuard();
    guard.accept(1000);

    expect(guard.accept(1000 + CLOSE_GUARD_DELAY_MS)).toBe(true);
  });

  it("counts the delay from the last accepted close, not from an ignored click", () => {
    const guard = new CloseGuard();
    guard.accept(1000);
    guard.accept(1000 + CLOSE_GUARD_DELAY_MS - 1);

    expect(guard.accept(1000 + CLOSE_GUARD_DELAY_MS)).toBe(true);
  });
});
