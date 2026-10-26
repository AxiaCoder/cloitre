import { describe, expect, it } from "vitest";

import { ActivityStore, isAnswerInput, isInterruptInput, parseActivityReport } from "./session-activity";

describe("parseActivityReport", () => {
  it("reads a well-formed payload", () => {
    expect(parseActivityReport({ tab: 3, state: "blocked" })).toEqual({ tab: 3, state: "blocked" });
    expect(parseActivityReport({ tab: 1, state: "working" })).toEqual({ tab: 1, state: "working" });
    expect(parseActivityReport({ tab: 2, state: "done" })).toEqual({ tab: 2, state: "done" });
  });

  it("ignores a state this version does not know", () => {
    expect(parseActivityReport({ tab: 3, state: "error" })).toBeUndefined();
    expect(parseActivityReport({ tab: 3, state: 1 })).toBeUndefined();
    expect(parseActivityReport({ tab: 3 })).toBeUndefined();
    expect(parseActivityReport({ tab: 3, state: "Blocked" })).toBeUndefined();
  });

  it("ignores a tab id that is not a whole number of 1 or more", () => {
    expect(parseActivityReport({ tab: 0, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: -1, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: 1.5, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: "1", state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: Number.NaN, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ state: "done" })).toBeUndefined();
  });

  it("ignores a payload that is not an object", () => {
    expect(parseActivityReport(null)).toBeUndefined();
    expect(parseActivityReport("done")).toBeUndefined();
    expect(parseActivityReport(undefined)).toBeUndefined();
  });

  it("reads the prompted state", () => {
    expect(parseActivityReport({ tab: 1, state: "prompted" })).toEqual({ tab: 1, state: "prompted" });
  });

  it("reads the background, settled and failed states", () => {
    for (const state of ["background", "settled", "failed"]) {
      expect(parseActivityReport({ tab: 1, state })).toEqual({ tab: 1, state });
    }
  });

  it("reads the agent of a subagent's report", () => {
    expect(parseActivityReport({ tab: 3, state: "blocked", agent: "a1b2-c3_D4" })).toEqual({
      tab: 3,
      state: "blocked",
      agent: "a1b2-c3_D4",
    });
  });

  it("ignores a report whose agent is not an agent id", () => {
    for (const agent of ["", "a b", "<x>", "a.b", "é", "a".repeat(65), 3, null]) {
      expect(parseActivityReport({ tab: 3, state: "blocked", agent })).toBeUndefined();
    }
    expect(parseActivityReport({ tab: 3, state: "blocked", agent: "a".repeat(64) })).toBeDefined();
  });
});

describe("isAnswerInput", () => {
  it("takes Enter, a digit or a lone Escape as an answer", () => {
    expect(isAnswerInput("\r")).toBe(true);
    expect(isAnswerInput("1")).toBe(true);
    expect(isAnswerInput("9")).toBe(true);
    expect(isAnswerInput("\x1b")).toBe(true);
  });

  it("takes pasted text holding Enter as an answer", () => {
    expect(isAnswerInput("yes\r")).toBe(true);
    expect(isAnswerInput("first line\rsecond line")).toBe(true);
  });

  it("does not take an escape sequence, a letter or longer text as an answer", () => {
    expect(isAnswerInput("\x1b[A")).toBe(false);
    expect(isAnswerInput("\x1b[B")).toBe(false);
    expect(isAnswerInput("a")).toBe(false);
    expect(isAnswerInput("12")).toBe(false);
    expect(isAnswerInput("")).toBe(false);
  });
});

describe("ActivityStore with agents", () => {
  it("keeps a subagent's block when another subagent works", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true, "agent-a");
    expect(store.report(1, "working", true, "agent-b")).toBe(false);
    expect(store.of(1)).toBe("blocked");
    expect(store.report(1, "working", true, "agent-a")).toBe(true);
    expect(store.of(1)).toBe("working");
  });

  it("keeps the main block when a subagent works, and a subagent's when the main conversation works", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    store.report(2, "blocked", true, "agent-a");
    store.report(1, "working", true, "agent-a");
    store.report(2, "working", true);
    expect(store.of(1)).toBe("blocked");
    expect(store.of(2)).toBe("blocked");
  });

  it("stays blocked until every agent that blocked the tab is done", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    store.report(1, "blocked", true, "agent-a");
    expect(store.report(1, "done", false)).toBe(false);
    expect(store.of(1)).toBe("blocked");
    expect(store.report(1, "working", false, "agent-a")).toBe(true);
    expect(store.of(1)).toBe("working");
  });

  it("ends every block of the tab on prompted, and works", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    store.report(1, "blocked", true, "agent-a");
    store.report(2, "done", false);
    expect(store.report(1, "prompted", true)).toBe(true);
    expect(store.report(2, "prompted", false)).toBe(true);
    expect(store.of(1)).toBe("working");
    expect(store.of(2)).toBe("working");
    expect(store.report(3, "prompted", false)).toBe(true);
    expect(store.of(3)).toBe("working");
  });

  it("ends the main block on the main conversation's done", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    expect(store.report(1, "done", false)).toBe(true);
    expect(store.of(1)).toBe("done");
  });

  it("ends every block of the tab when the user answers", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    store.report(1, "blocked", true, "agent-a");
    expect(store.answer(1)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    expect(store.answer(1)).toBe(false);
  });

  it("leaves a done tab done when the user types in it", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    expect(store.answer(1)).toBe(false);
    expect(store.of(1)).toBe("done");
  });

  it("drops an earlier done when the tab blocks, so answering leaves nothing", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    store.report(1, "blocked", true, "agent-a");
    expect(store.answer(1)).toBe(true);
    expect(store.of(1)).toBeUndefined();
  });

  it("shows blocked before done for one tab, and done once the user answers", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true, "agent-a");
    store.report(1, "done", false);
    expect(store.of(1)).toBe("blocked");
    expect(store.see(1)).toBe(false);
    expect(store.answer(1)).toBe(true);
    expect(store.of(1)).toBe("done");
  });
});

describe("ActivityStore", () => {
  it("blocks a tab, on screen or not", () => {
    const store = new ActivityStore();
    expect(store.report(1, "blocked", false)).toBe(true);
    expect(store.report(2, "blocked", true)).toBe(true);
    expect(store.of(1)).toBe("blocked");
    expect(store.of(2)).toBe("blocked");
  });

  it("reports no change when a tab is blocked again", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    expect(store.report(1, "blocked", true)).toBe(false);
    expect(store.of(1)).toBe("blocked");
  });

  it("reports no change when a done tab is done again out of sight", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    expect(store.report(1, "done", false)).toBe(false);
    expect(store.of(1)).toBe("done");
  });

  it("clears a done tab when its next turn ends on screen", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    expect(store.report(1, "done", true)).toBe(true);
    expect(store.of(1)).toBeUndefined();
  });

  it("does nothing when a tab without activity is seen", () => {
    const store = new ActivityStore();
    expect(store.see(1)).toBe(false);
    expect(store.of(1)).toBeUndefined();
  });

  it("keeps a blocked tab blocked when it is seen", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    expect(store.see(1)).toBe(false);
    expect(store.of(1)).toBe("blocked");
  });

  it("turns a blocked or done tab to working on working", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    store.report(2, "done", false);
    expect(store.report(1, "working", true)).toBe(true);
    expect(store.report(2, "working", false)).toBe(true);
    expect(store.of(1)).toBe("working");
    expect(store.of(2)).toBe("working");
    expect(store.report(3, "working", false)).toBe(true);
    expect(store.of(3)).toBe("working");
  });

  it("clears a blocked tab on done", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    expect(store.report(1, "done", true)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    store.report(2, "blocked", false);
    store.report(2, "done", false);
    expect(store.of(2)).toBe("done");
  });

  it("shows done only for a tab not seen", () => {
    const store = new ActivityStore();
    expect(store.report(1, "done", false)).toBe(true);
    expect(store.report(2, "done", true)).toBe(false);
    expect(store.of(1)).toBe("done");
    expect(store.of(2)).toBeUndefined();
  });

  it("puts a done tab out once seen", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    expect(store.see(1)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    expect(store.see(1)).toBe(false);
  });

  it("forgets the activity of a tab", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    store.report(2, "done", false);
    expect(store.forget(1)).toBe(true);
    expect(store.forget(2)).toBe(true);
    expect(store.forget(3)).toBe(false);
    expect(store.of(1)).toBeUndefined();
    expect(store.of(2)).toBeUndefined();
  });

  it("reports blocked before done for a set of tabs", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    store.report(2, "blocked", false);
    expect(store.mostUrgent([1, 2])).toBe("blocked");
    expect(store.mostUrgent([2, 1])).toBe("blocked");
    expect(store.mostUrgent([1, 3])).toBe("done");
    expect(store.mostUrgent([3])).toBeUndefined();
    expect(store.mostUrgent([])).toBeUndefined();
  });

  it("shows done for a set of tabs again once its blocked tab is answered", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    store.report(2, "blocked", false);
    store.report(2, "working", false);
    expect(store.mostUrgent([1, 2])).toBe("done");
  });

  it("ignores in a set the tabs of other projects", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    store.report(2, "done", false);
    expect(store.mostUrgent([2, 3])).toBe("done");
  });
});

describe("ActivityStore working and failed", () => {
  it("works from the prompt until the turn ends, on screen or not", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", true);
    store.report(2, "prompted", false);
    expect(store.see(1)).toBe(false);
    expect(store.of(1)).toBe("working");
    expect(store.report(1, "done", true)).toBe(true);
    expect(store.report(2, "done", false)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    expect(store.of(2)).toBe("done");
  });

  it("keeps working after the turn while background tasks run, and is done once a subagent settles them", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    expect(store.report(1, "background", false)).toBe(false);
    expect(store.of(1)).toBe("working");
    expect(store.report(1, "settled", false, "agent-a")).toBe(true);
    expect(store.of(1)).toBe("done");
  });

  it("shows nothing when background tasks settle on a seen tab", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", true);
    store.report(1, "background", true);
    expect(store.report(1, "settled", true, "agent-a")).toBe(true);
    expect(store.of(1)).toBeUndefined();
  });

  it("ends background work on the done of the turn that follows", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    store.report(1, "working", false);
    expect(store.of(1)).toBe("working");
    expect(store.report(1, "done", false)).toBe(true);
    expect(store.of(1)).toBe("done");
    expect(store.report(1, "settled", false, "agent-a")).toBe(false);
    expect(store.of(1)).toBe("done");
  });

  it("ignores a subagent that settles during a turn", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    expect(store.report(1, "settled", false, "agent-a")).toBe(false);
    expect(store.of(1)).toBe("working");
    expect(store.report(2, "settled", false, "agent-a")).toBe(false);
    expect(store.of(2)).toBeUndefined();
  });

  it("ignores background tasks settling after a new prompt", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    store.report(1, "prompted", false);
    expect(store.report(1, "settled", false, "agent-a")).toBe(false);
    expect(store.of(1)).toBe("working");
  });

  it("shows failed after an API error, seen or not, until the next prompt", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", true);
    expect(store.report(1, "failed", true)).toBe(true);
    expect(store.of(1)).toBe("failed");
    expect(store.see(1)).toBe(false);
    expect(store.of(1)).toBe("failed");
    expect(store.report(1, "working", true)).toBe(false);
    expect(store.report(1, "prompted", true)).toBe(true);
    expect(store.of(1)).toBe("working");
  });

  it("shows blocked over failed on one tab", () => {
    const store = new ActivityStore();
    store.report(1, "failed", false);
    expect(store.report(1, "blocked", false, "agent-a")).toBe(true);
    expect(store.of(1)).toBe("blocked");
    expect(store.answer(1)).toBe(true);
    expect(store.of(1)).toBe("failed");
  });

  it("forgets a working or failed tab", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    store.report(2, "failed", false);
    expect(store.forget(1)).toBe(true);
    expect(store.forget(2)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    expect(store.of(2)).toBeUndefined();
    expect(store.report(1, "settled", false)).toBe(false);
  });

  it("reports blocked, then failed, then done, then working for a set of tabs", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(2, "done", false);
    store.report(3, "failed", false);
    store.report(4, "blocked", false);
    expect(store.mostUrgent([1, 2, 3, 4])).toBe("blocked");
    expect(store.mostUrgent([1, 2, 3])).toBe("failed");
    expect(store.mostUrgent([3, 2, 1])).toBe("failed");
    expect(store.mostUrgent([1, 2])).toBe("done");
    expect(store.mostUrgent([1, 5])).toBe("working");
  });

  it("works again once a block of the turn is answered from the keyboard", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "blocked", false);
    expect(store.of(1)).toBe("blocked");
    expect(store.answer(1)).toBe(true);
    expect(store.of(1)).toBe("working");
  });

  it("keeps waiting for background tasks across a block answered from the keyboard", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    store.report(1, "blocked", false, "agent-a");
    store.answer(1);
    expect(store.of(1)).toBe("working");
    expect(store.report(1, "settled", false, "agent-a")).toBe(true);
    expect(store.of(1)).toBe("done");
  });

  it("keeps showing failed when a done follows on the failed tab", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "failed", false);
    expect(store.report(1, "done", false)).toBe(false);
    expect(store.of(1)).toBe("failed");
    expect(store.report(1, "done", true)).toBe(false);
    expect(store.of(1)).toBe("failed");
  });

  it("stops working when the turn fails, even with background tasks pending", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    store.report(1, "failed", false);
    expect(store.report(1, "settled", false, "agent-a")).toBe(false);
    expect(store.of(1)).toBe("failed");
    expect(store.report(1, "prompted", false)).toBe(true);
    expect(store.of(1)).toBe("working");
  });

  it("shows working after a failed tab is cleared by its next prompt, not done", () => {
    const store = new ActivityStore();
    store.report(1, "failed", false);
    store.report(1, "prompted", false);
    expect(store.mostUrgent([1])).toBe("working");
  });

  it("reports failed over done and working for a project, whatever the order", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(2, "failed", false);
    store.report(3, "done", false);
    expect(store.mostUrgent([1, 3, 2])).toBe("failed");
    expect(store.mostUrgent([3, 1])).toBe("done");
    expect(store.mostUrgent([1])).toBe("working");
  });
});

describe("isInterruptInput", () => {
  it("accepts a lone Escape or a lone Ctrl+C", () => {
    expect(isInterruptInput("\x1b")).toBe(true);
    expect(isInterruptInput("\x03")).toBe(true);
  });

  it("refuses an escape sequence, a letter or Enter", () => {
    expect(isInterruptInput("\x1b[A")).toBe(false);
    expect(isInterruptInput("a")).toBe(false);
    expect(isInterruptInput("\r")).toBe(false);
  });
});

describe("ActivityStore interrupt", () => {
  it("ends the work of a tab interrupted during its turn, without showing done", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    expect(store.interrupt(1)).toBe(true);
    expect(store.of(1)).toBeUndefined();
  });

  it("keeps a tab working when it only waits for background tasks", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    expect(store.interrupt(1)).toBe(false);
    expect(store.of(1)).toBe("working");
    expect(store.report(1, "settled", false, "agent-a")).toBe(true);
    expect(store.of(1)).toBe("done");
  });

  it("ends both the block and the work of a blocked working tab refused with Escape", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "blocked", false);
    expect(store.interrupt(1)).toBe(true);
    expect(store.of(1)).toBeUndefined();
  });

  it("changes nothing on a tab without activity", () => {
    const store = new ActivityStore();
    expect(store.interrupt(1)).toBe(false);
    expect(store.of(1)).toBeUndefined();
  });
});

describe("ActivityStore turn woken by background tasks", () => {
  it("stops waiting for background tasks once the main conversation works again", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    store.report(1, "working", false);
    expect(store.report(1, "settled", false, "agent-a")).toBe(false);
    expect(store.of(1)).toBe("working");
    expect(store.report(1, "done", false)).toBe(true);
    expect(store.of(1)).toBe("done");
  });

  it("keeps waiting for background tasks while only a subagent works", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "background", false);
    store.report(1, "working", false, "agent-a");
    expect(store.report(1, "settled", false, "agent-a")).toBe(true);
    expect(store.of(1)).toBe("done");
  });
});
