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
    stopSessions,
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
    flow.dismiss();
    expect(flow.notice.kind).toBe("downloading");
    finish();
    await installing;
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
});

describe("update texts", () => {
  it("count the sessions that stop", () => {
    expect(messages.updateSessions(0)).toBe("No session is running.");
    expect(messages.updateSessions(1)).toBe("Your running session will stop.");
    expect(messages.updateSessions(3)).toBe("Your 3 running sessions will stop.");
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
