import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { describe, expect, it, vi } from "vitest";

import { messages, texts } from "./strings";
import { downloadFailure, runningSessions, UpdateFlow, type PendingUpdate, type UpdateNotice } from "./updates";

/** An update to 0.4.0 from 0.3.2 whose download reports 4.1 of 9.8 MB; `overrides` replace its parts. */
function fakeUpdate(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    version: "0.4.0",
    currentVersion: "0.3.2",
    download: (onEvent?: (event: DownloadEvent) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 9_800_000 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 4_100_000 } });
      onEvent?.({ event: "Finished" });
      return Promise.resolve();
    },
    install: () => Promise.resolve(),
    ...overrides,
  };
}

/** An update flow on `check` and `stopSessions`, with every notice it shows. */
function flowWith(check: () => Promise<PendingUpdate | null>, stopSessions = () => Promise.resolve()) {
  const shown: UpdateNotice[] = [];
  const flow = new UpdateFlow({
    check,
    confirmInstall: () => Promise.resolve(true),
    stopSessions,
    sessionsStopped: () => undefined,
    show: (notice) => shown.push(notice),
  });
  return { flow, shown };
}

describe("UpdateFlow.checkAtStartup", () => {
  it("shows the new version and the running one", async () => {
    const { flow } = flowWith(() => Promise.resolve(fakeUpdate()));
    await flow.checkAtStartup();
    expect(flow.notice).toEqual({ kind: "available", version: "0.4.0", current: "0.3.2" });
  });

  it("shows nothing when the app is up to date", async () => {
    const { flow, shown } = flowWith(() => Promise.resolve(null));
    await flow.checkAtStartup();
    expect(shown).toEqual([]);
    expect(flow.notice.kind).toBe("none");
  });

  it("stays silent when the check fails, as in a development build without the updater", async () => {
    const { flow, shown } = flowWith(() => Promise.reject(new Error("plugin updater not found")));
    await flow.checkAtStartup();
    expect(shown).toEqual([]);
  });

  it("downloads nothing on its own", async () => {
    const download = vi.fn(() => Promise.resolve());
    const { flow } = flowWith(() => Promise.resolve(fakeUpdate({ download })));
    await flow.checkAtStartup();
    expect(download).not.toHaveBeenCalled();
  });
});

describe("UpdateFlow.dismiss", () => {
  it("hides an available update", async () => {
    const { flow } = flowWith(() => Promise.resolve(fakeUpdate()));
    await flow.checkAtStartup();
    flow.dismiss();
    expect(flow.notice.kind).toBe("none");
  });
});

describe("UpdateFlow.install", () => {
  it("downloads with progress, then stops the sessions, then installs", async () => {
    const order: string[] = [];
    const update = fakeUpdate({
      install: () => {
        order.push("install");
        return Promise.resolve();
      },
    });
    const { flow, shown } = flowWith(
      () => Promise.resolve(update),
      () => {
        order.push("stop");
        return Promise.resolve();
      },
    );
    await flow.checkAtStartup();
    await flow.install();
    expect(order).toEqual(["stop", "install"]);
    expect(shown).toContainEqual({ kind: "downloading", version: "0.4.0", received: 4_100_000, total: 9_800_000 });
  });

  it("keeps the sessions running when the signature does not match", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const install = vi.fn(() => Promise.resolve());
    const update = fakeUpdate({
      download: () => Promise.reject(new Error("The signature verification failed")),
      install,
    });
    const { flow } = flowWith(() => Promise.resolve(update), stop);
    await flow.checkAtStartup();
    await flow.install();
    expect(flow.notice).toEqual({ kind: "failed", version: "0.4.0", reason: "signature" });
    expect(stop).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("starts over from the download when tried again", async () => {
    const download = vi
      .fn<(onEvent?: (event: DownloadEvent) => void) => Promise<void>>()
      .mockRejectedValueOnce(new Error("error sending request"))
      .mockResolvedValueOnce(undefined);
    const { flow } = flowWith(() => Promise.resolve(fakeUpdate({ download })));
    await flow.checkAtStartup();
    await flow.install();
    expect(flow.notice).toEqual({ kind: "failed", version: "0.4.0", reason: "network" });
    await flow.install();
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("says the installer did not start when the install fails", async () => {
    const update = fakeUpdate({ install: () => Promise.reject(new Error("access denied")) });
    const { flow } = flowWith(() => Promise.resolve(update));
    await flow.checkAtStartup();
    await flow.install();
    expect(flow.notice).toEqual({ kind: "failed", version: "0.4.0", reason: "install" });
  });

  it("cannot be hidden while downloading", async () => {
    let finish: () => void = () => undefined;
    const update = fakeUpdate({
      download: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const { flow } = flowWith(() => Promise.resolve(update));
    await flow.checkAtStartup();
    const installing = flow.install();
    await vi.waitFor(() => {
      expect(flow.notice.kind).toBe("downloading");
    });
    flow.dismiss();
    expect(flow.notice.kind).toBe("downloading");
    finish();
    await installing;
  });
});

describe("UpdateFlow.install, sessions and download", () => {
  it("stops the sessions only once the download has finished", async () => {
    const order: string[] = [];
    const update = fakeUpdate({
      download: () => {
        order.push("download");
        return Promise.resolve();
      },
      install: () => {
        order.push("install");
        return Promise.resolve();
      },
    });
    const { flow } = flowWith(
      () => Promise.resolve(update),
      () => {
        order.push("stop");
        return Promise.resolve();
      },
    );
    await flow.checkAtStartup();
    await flow.install();
    expect(order).toEqual(["download", "stop", "install"]);
  });

  it("keeps the sessions running and installs nothing when the download stops", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const install = vi.fn(() => Promise.resolve());
    const update = fakeUpdate({ download: () => Promise.reject(new Error("error sending request")), install });
    const { flow } = flowWith(() => Promise.resolve(update), stop);
    await flow.checkAtStartup();
    await flow.install();
    expect(flow.notice).toEqual({ kind: "failed", version: "0.4.0", reason: "network" });
    expect(stop).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("has stopped the sessions when the installer fails to start", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const update = fakeUpdate({ install: () => Promise.reject(new Error("access denied")) });
    const { flow } = flowWith(() => Promise.resolve(update), stop);
    await flow.checkAtStartup();
    await flow.install();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does nothing when no update was announced", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const { flow, shown } = flowWith(() => Promise.resolve(null), stop);
    await flow.checkAtStartup();
    await flow.install();
    expect(shown).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does nothing when the startup check failed", async () => {
    const { flow, shown } = flowWith(() => Promise.reject(new Error("error sending request")));
    await flow.checkAtStartup();
    await flow.install();
    expect(shown).toEqual([]);
  });

  it("starts one download only when asked twice", async () => {
    let finish: () => void = () => undefined;
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { flow } = flowWith(() => Promise.resolve(fakeUpdate({ download })));
    await flow.checkAtStartup();
    const first = flow.install();
    await flow.install();
    finish();
    await first;
    expect(download).toHaveBeenCalledOnce();
  });

  it("shows the download from zero, then each chunk", async () => {
    const update = fakeUpdate({
      download: (onEvent?: (event: DownloadEvent) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 1_000 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 400 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 600 } });
        return Promise.resolve();
      },
    });
    const { flow, shown } = flowWith(() => Promise.resolve(update));
    await flow.checkAtStartup();
    await flow.install();
    expect(shown.filter((notice) => notice.kind === "downloading")).toEqual([
      { kind: "downloading", version: "0.4.0", received: 0, total: undefined },
      { kind: "downloading", version: "0.4.0", received: 0, total: 1_000 },
      { kind: "downloading", version: "0.4.0", received: 400, total: 1_000 },
      { kind: "downloading", version: "0.4.0", received: 1_000, total: 1_000 },
    ]);
  });

  it("keeps the size unknown when the server does not give it", async () => {
    const update = fakeUpdate({
      download: (onEvent?: (event: DownloadEvent) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: undefined } });
        onEvent?.({ event: "Progress", data: { chunkLength: 250 } });
        return Promise.resolve();
      },
    });
    const { flow, shown } = flowWith(() => Promise.resolve(update));
    await flow.checkAtStartup();
    await flow.install();
    expect(shown).toContainEqual({ kind: "downloading", version: "0.4.0", received: 250, total: undefined });
  });
});

describe("UpdateFlow.dismiss, other states", () => {
  it("hides a failed update", async () => {
    const update = fakeUpdate({ download: () => Promise.reject(new Error("error sending request")) });
    const { flow } = flowWith(() => Promise.resolve(update));
    await flow.checkAtStartup();
    await flow.install();
    flow.dismiss();
    expect(flow.notice.kind).toBe("none");
  });

  it("draws nothing when no notice is shown", () => {
    const { flow, shown } = flowWith(() => Promise.resolve(null));
    flow.dismiss();
    expect(shown).toEqual([]);
  });

  it("does not ask the server again", async () => {
    const check = vi.fn(() => Promise.resolve(fakeUpdate()));
    const { flow } = flowWith(check);
    await flow.checkAtStartup();
    flow.dismiss();
    expect(check).toHaveBeenCalledOnce();
    expect(flow.notice.kind).toBe("none");
  });
});

describe("downloadFailure, on the updater's own messages", () => {
  it.each([
    "The signature verification failed",
    "Invalid encoding in minisign data",
    "Unexpected signature algorithm",
    "This signature algorithm is not supported by this implementation",
    "The signature was created with a different key than the one provided",
    "The signature dW50cnVzdGVk could not be decoded, please check if it is a valid base64 string.",
    "The update was signed for version 0.3.0 but the update endpoint announced version 0.4.0.",
    "The update signature does not specify the version it was signed for, which `requireSignedVersion` requires.",
    "Invalid symbol 45, offset 3.",
    "Invalid padding",
  ])("calls %j a signature fault", (message) => {
    expect(downloadFailure(message)).toBe("signature");
  });

  it.each([
    "error sending request for url (https://example.com/app-setup.exe)",
    "`Download request failed with status: 404 Not Found`",
    "operation timed out",
  ])("calls %j a network fault", (message) => {
    expect(downloadFailure(message)).toBe("network");
  });

  it("reads an Error object as its message", () => {
    expect(downloadFailure(new Error("The signature verification failed"))).toBe("signature");
  });
});

describe("downloadFailure", () => {
  it("tells a signature fault from a network fault", () => {
    expect(downloadFailure("The signature was created with a different key than the one provided")).toBe("signature");
    expect(downloadFailure("Invalid encoding in minisign data")).toBe("signature");
    expect(downloadFailure("`error decoding response body`")).toBe("network");
  });
});

describe("runningSessions", () => {
  it("counts started and starting sessions only", () => {
    expect(runningSessions(["running", "starting", "exited", "restored", "failed"])).toBe(2);
  });

  it("counts no session when there is no tab", () => {
    expect(runningSessions([])).toBe(0);
  });
});

describe("update texts", () => {
  it("count the sessions that stop", () => {
    expect(messages.updateSessions(0)).toBe("No session is running.");
    expect(messages.updateSessions(1)).toBe("Your running session will stop.");
    expect(messages.updateSessions(3)).toBe("Your 3 running sessions will stop.");
  });

  it("use the plural from two sessions", () => {
    expect(messages.updateSessions(2)).toBe("Your 2 running sessions will stop.");
  });

  it("show a download that has not started", () => {
    expect(messages.downloadProgress(0, undefined)).toBe("0.0 MB · the app restarts when done");
  });

  it("show the download in megabytes", () => {
    expect(messages.downloadProgress(4_100_000, 9_800_000)).toBe("4.1 of 9.8 MB · the app restarts when done");
    expect(messages.downloadProgress(4_100_000, undefined)).toBe("4.1 MB · the app restarts when done");
  });

  it("name the notice and the dialog", () => {
    expect(messages.updateAvailable("0.4.0")).toBe("Version 0.4.0 is available");
    expect(messages.updateCurrent("0.3.2")).toBe("You have 0.3.2");
    expect(messages.installTitle("0.4.0")).toBe("Install version 0.4.0?");
    expect(messages.updateCompact("0.4.0")).toBe("Version 0.4.0 is available · Install…");
    expect(texts.updateHide).toBe("Hide until next start");
  });
});

/**
 * An update flow on `update` with every port, the confirmation and the
 * stopped-sessions notice included, recording each port call in `calls`.
 * `answers` are the answers of the successive confirmations; past them, it confirms.
 */
function flowWithConfirmation(update: PendingUpdate, answers: boolean[] = []) {
  const calls: string[] = [];
  const confirmInstall = vi.fn((version: string) => {
    calls.push(`confirm ${version}`);
    return Promise.resolve(answers.shift() ?? true);
  });
  const sessionsStopped = vi.fn(() => {
    calls.push("sessions stopped");
  });
  const ports = {
    check: () => Promise.resolve(update),
    stopSessions: () => {
      calls.push("stop");
      return Promise.resolve();
    },
    show: () => undefined,
    confirmInstall,
    sessionsStopped,
  };
  const flow = new UpdateFlow(ports);
  return { flow, calls, confirmInstall, sessionsStopped };
}

describe("UpdateFlow.install, confirmation of every attempt", () => {
  it("asks for confirmation again before trying a failed download again", async () => {
    const download = vi
      .fn<(onEvent?: (event: DownloadEvent) => void) => Promise<void>>()
      .mockRejectedValueOnce(new Error("error sending request"))
      .mockResolvedValueOnce(undefined);
    const { flow, confirmInstall } = flowWithConfirmation(fakeUpdate({ download }));
    await flow.checkAtStartup();
    await flow.install();
    expect(flow.notice).toEqual({ kind: "failed", version: "0.4.0", reason: "network" });
    await flow.install();
    expect(confirmInstall).toHaveBeenCalledTimes(2);
    expect(confirmInstall).toHaveBeenLastCalledWith("0.4.0");
  });

  it("stops no session and downloads no more when the retry is cancelled", async () => {
    const download = vi
      .fn<(onEvent?: (event: DownloadEvent) => void) => Promise<void>>()
      .mockRejectedValue(new Error("error sending request"));
    const update = fakeUpdate({ download });
    const { flow, calls } = flowWithConfirmation(update, [true, false]);
    await flow.checkAtStartup();
    await flow.install();
    await flow.install();
    expect(download).toHaveBeenCalledOnce();
    expect(calls).not.toContain("stop");
  });
});

describe("UpdateFlow.install, sessions after a failed install", () => {
  it("reports the stopped sessions once the installer fails to start", async () => {
    const update = fakeUpdate({ install: () => Promise.reject(new Error("access denied")) });
    const { flow, calls, sessionsStopped } = flowWithConfirmation(update);
    await flow.checkAtStartup();
    await flow.install();
    expect(flow.notice).toEqual({ kind: "failed", version: "0.4.0", reason: "install" });
    expect(sessionsStopped).toHaveBeenCalledOnce();
    expect(calls.indexOf("sessions stopped")).toBeGreaterThan(calls.indexOf("stop"));
  });
});
