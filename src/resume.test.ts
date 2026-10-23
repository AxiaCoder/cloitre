import { describe, expect, it } from "vitest";

import { isFailedResume, RESUME_FAILURE_WINDOW_MS } from "./resume";

describe("isFailedResume", () => {
  it("counts a resume ending with a non-zero code right after its start", () => {
    expect(isFailedResume("resume", 1, 300)).toBe(true);
  });

  it("does not count a resume ending with code 0", () => {
    expect(isFailedResume("resume", 0, 300)).toBe(false);
  });

  it("counts a resume failing just before the window closes", () => {
    expect(isFailedResume("resume", 1, RESUME_FAILURE_WINDOW_MS - 1)).toBe(true);
  });

  it("does not count a resume ending once the window has passed", () => {
    expect(isFailedResume("resume", 1, RESUME_FAILURE_WINDOW_MS)).toBe(false);
  });

  it("never counts a new session", () => {
    expect(isFailedResume("new", 1, 300)).toBe(false);
  });
});
