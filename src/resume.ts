import type { SpawnMode } from "./pty";

/** How long after its start, in milliseconds, a failing resume still counts as a failed resume. */
export const RESUME_FAILURE_WINDOW_MS = 10_000;

/**
 * Tells whether a session that ended with `code`, `elapsedMs` milliseconds
 * after it was started in `mode`, is a resume that failed: a `"resume"` start
 * ending with a non-zero code within {@link RESUME_FAILURE_WINDOW_MS}.
 */
export function isFailedResume(mode: SpawnMode, code: number, elapsedMs: number): boolean {
  return mode === "resume" && code !== 0 && elapsedMs < RESUME_FAILURE_WINDOW_MS;
}
