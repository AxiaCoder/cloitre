/** The longest title a tab keeps and Rust saves, in code points; Rust refuses longer ones. */
export const MAX_TITLE_LENGTH = 256;

/** The longest label a tab shows in the tab bar, in code points, ellipsis included. */
export const SHOWN_TITLE_LENGTH = 40;

/** How long a title must stay unchanged before it is saved, in milliseconds. */
export const TITLE_SAVE_DELAY_MS = 1000;

/** Whether code point `code` is a C0 control, DEL or a C1 control. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Returns the title a tab keeps for `raw`, the title its terminal received:
 * without control characters, trimmed and cut to {@link MAX_TITLE_LENGTH}
 * code points. Returns `null` when nothing is left.
 */
export function cleanTitle(raw: string): string | null {
  const kept = Array.from(raw)
    .filter((char) => !isControl(char.codePointAt(0) ?? 0))
    .join("")
    .trim();
  const cut = Array.from(kept).slice(0, MAX_TITLE_LENGTH).join("").trimEnd();
  return cut === "" ? null : cut;
}

/**
 * Returns `text` as the tab bar shows it: unchanged up to
 * {@link SHOWN_TITLE_LENGTH} code points, else cut to one less and ended
 * with an ellipsis.
 */
export function shortenLabel(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= SHOWN_TITLE_LENGTH) {
    return text;
  }
  return `${chars.slice(0, SHOWN_TITLE_LENGTH - 1).join("").trimEnd()}…`;
}

/** Saves the title of tab `tabId`, `null` to clear it. */
export type SaveTitle = (tabId: number, title: string | null) => Promise<void>;

/**
 * Saves each tab's title once it has stayed unchanged for a delay, and only
 * when it differs from the last one saved, so a title that changes many times
 * a second is written once.
 */
export class TitleSaver {
  private readonly saved = new Map<number, string | null>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * Saves through `save`, `delayMs` after the last change of a tab's title.
   * A failed save goes to `onError` and is tried again at the next change.
   */
  constructor(
    private readonly save: SaveTitle,
    private readonly onError: (tabId: number, error: unknown) => void,
    private readonly delayMs = TITLE_SAVE_DELAY_MS,
  ) {}

  /** Records `title` as the one already saved for tab `tabId`, as on restore. */
  markSaved(tabId: number, title: string | null): void {
    this.saved.set(tabId, title);
  }

  /** Saves `title` for tab `tabId` after the delay, unless another title replaces it first. */
  schedule(tabId: number, title: string | null): void {
    clearTimeout(this.timers.get(tabId));
    this.timers.set(
      tabId,
      setTimeout(() => {
        this.timers.delete(tabId);
        this.flush(tabId, title);
      }, this.delayMs),
    );
  }

  /** Drops the pending save and the saved title of tab `tabId`, once it is closed. */
  forget(tabId: number): void {
    clearTimeout(this.timers.get(tabId));
    this.timers.delete(tabId);
    this.saved.delete(tabId);
  }

  /** Saves `title` for tab `tabId` when it differs from the last one saved. */
  private flush(tabId: number, title: string | null): void {
    if ((this.saved.get(tabId) ?? null) === title) {
      return;
    }
    this.saved.set(tabId, title);
    this.save(tabId, title).catch((error: unknown) => {
      if (this.saved.get(tabId) === title) {
        this.saved.delete(tabId);
      }
      this.onError(tabId, error);
    });
  }
}
