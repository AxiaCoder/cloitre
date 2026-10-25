import type { DownloadEvent } from "@tauri-apps/plugin-updater";

/** Why an update was not installed: a signature that does not match, a download that stopped, or an installer that did not start. */
export type FailureReason = "signature" | "network" | "install";

/** What the update notice of the rail shows. */
export type UpdateNotice =
  | { readonly kind: "none" }
  | { readonly kind: "available"; readonly version: string; readonly current: string }
  | {
      readonly kind: "downloading";
      readonly version: string;
      /** Bytes received so far. */
      readonly received: number;
      /** Size of the download in bytes, `undefined` until the server gives it. */
      readonly total: number | undefined;
    }
  | { readonly kind: "failed"; readonly version: string; readonly reason: FailureReason };

/** The notice of an app with no update to offer. */
export const NO_UPDATE: UpdateNotice = { kind: "none" };

/** An update the update server announced, as the updater plugin gives it. */
export interface PendingUpdate {
  /** The version announced. */
  readonly version: string;
  /** The version running now. */
  readonly currentVersion: string;
  /** Downloads the update and checks its signature; rejects when either fails. */
  download(onEvent?: (event: DownloadEvent) => void): Promise<void>;
  /** Installs the downloaded update; on Windows the app exits and the installer starts it again. */
  install(): Promise<void>;
}

/** What {@link UpdateFlow} needs from the app. */
export interface UpdatePorts {
  /** Asks the update server for a newer version: `null` when there is none. Rejects when the updater is missing (a development build) or the server cannot be reached. */
  check(): Promise<PendingUpdate | null>;
  /** Stops every running `claude` session; never rejects. */
  stopSessions(): Promise<void>;
  /** Draws `notice`. */
  show(notice: UpdateNotice): void;
}

/** The words of an updater error that point at the signature rather than the download. */
const SIGNATURE_ERROR = /signature|minisign|different key|algorithm|encoding|base64|signed version/iu;

/** Tells why a download failed from updater error `error`: a signature fault, or else a network fault. */
export function downloadFailure(error: unknown): FailureReason {
  return SIGNATURE_ERROR.test(String(error)) ? "signature" : "network";
}

/** Returns how many of `states`, the states of the session tabs, are running a session: started or starting. */
export function runningSessions(states: Iterable<string>): number {
  let count = 0;
  for (const state of states) {
    if (state === "running" || state === "starting") {
      count += 1;
    }
  }
  return count;
}

/**
 * Follows one update from the startup check to the install: a newer version
 * shows a notice, and nothing is downloaded until {@link UpdateFlow.install}.
 * Installing downloads first, sessions still running, then stops every
 * session and installs, which restarts the app.
 */
export class UpdateFlow {
  private update: PendingUpdate | undefined;
  private shown: UpdateNotice = NO_UPDATE;

  /** Uses `ports` to check, stop sessions and draw. */
  constructor(private readonly ports: UpdatePorts) {}

  /** The notice drawn now. */
  get notice(): UpdateNotice {
    return this.shown;
  }

  /** Checks for a newer version and shows it when there is one. A check that fails shows nothing. */
  async checkAtStartup(): Promise<void> {
    let update: PendingUpdate | null;
    try {
      update = await this.ports.check();
    } catch {
      return;
    }
    if (update === null) {
      return;
    }
    this.update = update;
    this.set({ kind: "available", version: update.version, current: update.currentVersion });
  }

  /** Hides the notice until the next start; a download under way keeps it. */
  dismiss(): void {
    if (this.shown.kind === "available" || this.shown.kind === "failed") {
      this.set(NO_UPDATE);
    }
  }

  /**
   * Downloads the update, showing progress, then stops every session and
   * installs it. A download or an install that fails shows why; calling
   * again starts over from the download. Does nothing with no update, or
   * while a download is under way.
   */
  async install(): Promise<void> {
    const update = this.update;
    if (update === undefined || this.shown.kind === "downloading") {
      return;
    }
    const { version } = update;
    let received = 0;
    let total: number | undefined;
    this.set({ kind: "downloading", version, received, total });
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        }
        this.set({ kind: "downloading", version, received, total });
      });
    } catch (error: unknown) {
      this.set({ kind: "failed", version, reason: downloadFailure(error) });
      return;
    }
    await this.ports.stopSessions();
    try {
      await update.install();
    } catch {
      this.set({ kind: "failed", version, reason: "install" });
    }
  }

  /** Records `notice` and draws it. */
  private set(notice: UpdateNotice): void {
    this.shown = notice;
    this.ports.show(notice);
  }
}
