/**
 * Every text the interface shows, in one place. The fixed texts are in
 * {@link texts}, reachable from the page by key; the texts built from a value
 * are the functions of {@link messages}.
 */

import type { MarkerMode } from "./project-menu";

/** The fixed texts of the interface, by key. `index.html` names them in `data-text`, `data-label` and `data-title`. */
export const texts = {
  closeWarning: "Close the warning",
  devTools: "Developer tools",
  renderer: "Renderer",
  rendererDom: "DOM",
  rendererWebgl: "WebGL",
  unicodeWidths: "Unicode widths",
  unicode15Graphemes: "15 + graphemes",
  mark: "Mark",
  markTitle: "Mark the recording (F9)",
  recording: "Recording",
  replaySpeed: "Replay speed",
  speedInstant: "Instant",
  speedRealtime: "Real time",
  replay: "Replay",
  nextMark: "Next mark",
  stopReplay: "Stop replay",
  noSession: "No session",
  projects: "Projects",
  openFolder: "Open a folder",
  sessions: "Sessions",
  newSession: "New session",
  noProjectOpen: "No project open",
  noProjectHint: "Each folder you open becomes a project, with its own Claude Code sessions.",
  newSessionStartsIn: "A new session starts in",
  startClaude: "Start Claude Code",
  missingFolderTitle: "The project folder cannot be found",
  missingFolderHint: "It may have been moved or renamed.",
  chooseAnotherFolder: "Choose another folder",
  removeProject: "Remove the project",
  markerShow: "Show",
  markerColors: "Color",
  markerIcons: "Icon",
  removeProjectEntry: "Remove project…",
  cancel: "Cancel",
  confirmRemove: "Remove project",
  folderStays: "The folder stays on disk:",
  restart: "Restart",
  close: "Close",
  resume: "Resume",
  resumeOffer: "Resume the previous conversation, or start a new session.",
  startingTitle: "Starting Claude Code",
  startFailedTitle: "Claude Code could not start",
  tryAgain: "Try again",
  notRecorded: "not recorded",
  noSessionToMark: "No session to mark",
  noRecordingChosen: "No recording chosen",
  selectProjectToReplay: "Select a project to replay in",
  replayStopped: "Replay stopped",
  webglLost: "WebGL context lost, back to the DOM renderer",
  webglUnavailable: "WebGL is not available, DOM renderer kept",
  updateHide: "Hide until next start",
  installUpdate: "Install update…",
  installAndRestart: "Install and restart",
  updateRestarts: "The app will restart once the update is downloaded.",
  updateTabsComeBack: "Your tabs come back after the restart, each with Resume or New session.",
  updateFailedTitle: "Update not installed",
  updateSignatureFailed: "The file's signature does not match. Nothing changed and your sessions are still running.",
  updateNetworkFailed: "The download stopped. Check your connection.",
  updateInstallFailed: "The installer could not start. Reopen your tabs with Resume.",
} as const;

/** The key of a fixed text. */
export type TextKey = keyof typeof texts;

/** The texts of the interface built from a value. */
export const messages = {
  /** The end notice of a session that ended with exit code `code`. */
  sessionEnded: (code: number) => `Claude Code ended (code ${String(code)})`,
  /** The start notice after a resume that exited with `code` right away. */
  resumeFailed: (code: number) =>
    `Claude Code exited with code ${String(code)} while resuming. The previous conversation may no longer exist.`,
  /** The folder line of the starting card. */
  startingFolder: (path: string) => `Folder: ${path}`,
  /** The no-session state title of project `name`. */
  noSessionTitle: (name: string) => `${name} has no session`,
  /** The label of session tab number `number` of its project. */
  sessionLabel: (number: number) => `Session ${String(number)}`,
  /** The label of the replay tab showing `recording`. */
  replayLabel: (recording: string) => `Replay ${recording}`,
  /** The tooltip of session tab `label` in `state`. */
  tabTitle: (label: string, state: string) => `${label} (${state})`,
  /** The accessible name of the close button of tab `label`. */
  closeTab: (label: string) => `Close ${label}`,
  /** The tooltip of a project's session count. */
  sessionCount: (count: number) => (count === 1 ? "1 session" : `${String(count)} sessions`),
  /** The tooltip of project `name` in folder `path`. */
  projectTitle: (name: string, path: string) => `${name}\n${path}`,
  /** The accessible name of the marker menu of project `name`. */
  markerMenu: (name: string) => `Marker of ${name}`,
  /** The accessible name of marker color `color`. */
  markerColor: (color: string) => `Color ${color}`,
  /** The accessible name of marker icon `icon`. */
  markerIcon: (icon: string) => `Icon ${icon}`,
  /** The line of the marker menu when its switch shows the other mode than `current`, the one the project shows. */
  markerHint: (current: MarkerMode) =>
    current === "color"
      ? "Showing a color now. Pick an icon to replace it."
      : "Showing an icon now. Pick a color to replace it.",
  /** The title of the dialog that removes project `name`. */
  removeTitle: (name: string) => `Remove ${name}?`,
  /** What removing a project does to its `count` open tabs. */
  removeTabs: (count: number) =>
    count === 0
      ? "No tab is open for it."
      : count === 1
        ? "Its tab will close and its session will stop."
        : `Its ${String(count)} tabs will close and their sessions will stop.`,
  /** The error of a removal Rust refused with `reason`; a final period of `reason` is dropped. */
  removeFailed: (reason: string) =>
    `The project could not be removed: ${reason.trim().replace(/\.$/u, "")}. Nothing has changed. Try again.`,
  /** The tooltip of project `name` whose folder `path` is gone. */
  missingProjectTitle: (name: string, path: string) => `${name}\nFolder not found: ${path}`,
  /** The recording list entry of `name`, `kilobytes` long. */
  recordingEntry: (name: string, kilobytes: number) => `${name} (${String(kilobytes)} KB)`,
  /** The recording indicator of a session recorded in `name`. */
  recordingName: (name: string) => `● recording ${name}`,
  /** The status after a marker dropped at `time`. */
  markedAt: (time: string) => `Marked at ${time}`,
  /** The status after loading recording `name` whose last record was dropped. */
  truncatedRecording: (name: string) => `${name}: the last record is incomplete and was dropped`,
  /** The status while recording `name` replays. */
  replaying: (name: string) => `Replaying ${name}`,
  /** The status once recording `name` has replayed to its end. */
  endOfRecording: (name: string) => `${name}: end of recording`,
  /** The status of recording `name` paused at marker number `marker`. */
  pausedAtMarker: (name: string, marker: number) => `${name}: paused at marker ${String(marker)}`,
  /** The title of the update notice for `version`. */
  updateAvailable: (version: string) => `Version ${version} is available`,
  /** The line under the update notice title, naming the `current` version. */
  updateCurrent: (current: string) => `You have ${current}`,
  /** The label of the update button of a narrow rail, for `version`. */
  updateCompact: (version: string) => `Version ${version} is available · Install…`,
  /** The title of the dialog that installs `version`. */
  installTitle: (version: string) => `Install version ${version}?`,
  /** What installing an update does to the `count` running sessions. */
  updateSessions: (count: number) =>
    count === 0
      ? "No session is running."
      : count === 1
        ? "Your running session will stop."
        : `Your ${String(count)} running sessions will stop.`,
  /** The title of the update notice while `version` downloads. */
  downloadingUpdate: (version: string) => `Downloading ${version}`,
  /** The progress line of a download: `received` of `total` bytes, in megabytes; `total` may be unknown. */
  downloadProgress: (received: number, total: number | undefined) => {
    const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);
    const amount =
      total === undefined ? `${megabytes(received)} MB` : `${megabytes(received)} of ${megabytes(total)} MB`;
    return `${amount} · the app restarts when done`;
  },
  /** The status of recording `name` replayed to its end looking for a marker. */
  noMarkerLeft: (name: string) => `${name}: no marker left, end of recording`,
} as const;

/** Returns whether `key` names a fixed text. */
export function isTextKey(key: string): key is TextKey {
  return Object.prototype.hasOwnProperty.call(texts, key);
}

/** The attributes that name a fixed text, and where the text goes. */
const TEXT_ATTRIBUTES = [
  ["data-text", "textContent"],
  ["data-label", "aria-label"],
  ["data-title", "title"],
] as const;

/** The parts of an element {@link fillTexts} reads and writes. */
export interface TextTarget {
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** The part of a page {@link fillTexts} searches. */
export interface TextRoot {
  querySelectorAll(selectors: string): Iterable<TextTarget>;
}

/**
 * Fills, under `root`, every element naming a fixed text: `data-text` sets
 * its text content, `data-label` its `aria-label`, `data-title` its `title`.
 * @throws {Error} when an element names a key {@link texts} lacks
 */
export function fillTexts(root: TextRoot): void {
  const selectors = TEXT_ATTRIBUTES.map(([attribute]) => `[${attribute}]`).join(",");
  for (const target of root.querySelectorAll(selectors)) {
    for (const [attribute, destination] of TEXT_ATTRIBUTES) {
      const key = target.getAttribute(attribute);
      if (key === null) {
        continue;
      }
      if (!isTextKey(key)) {
        throw new Error(`unknown text key "${key}" in ${attribute}`);
      }
      if (destination === "textContent") {
        target.textContent = texts[key];
      } else {
        target.setAttribute(destination, texts[key]);
      }
    }
  }
}
