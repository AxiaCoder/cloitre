/**
 * The app settings the user picks in the settings dialog, kept in the
 * webview's local storage.
 */

/** How long a session tab may stay idle before its session is stopped, in minutes, or `"never"`. */
export type IdleDelay = "never" | 5 | 15 | 30 | 60 | 120 | 240;

/** Every idle delay the settings dialog offers, in the order it lists them. */
export const IDLE_DELAYS: readonly IdleDelay[] = ["never", 5, 15, 30, 60, 120, 240];

/** The idle delay when none, or an unknown one, is stored. */
export const DEFAULT_IDLE_DELAY: IdleDelay = 60;

/** The local storage key of the idle delay. */
export const IDLE_DELAY_KEY = "cloitre.idleStopDelay";

/** The part of `Storage` the settings use. */
export type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

/** Returns `delay` as stored and as a select option value: `"never"` or its minutes. */
export function idleDelayValue(delay: IdleDelay): string {
  return String(delay);
}

/** Returns the idle delay `value` names, or {@link DEFAULT_IDLE_DELAY} when it names none, `null` included. */
export function parseIdleDelay(value: string | null): IdleDelay {
  return IDLE_DELAYS.find((delay) => idleDelayValue(delay) === value) ?? DEFAULT_IDLE_DELAY;
}

/** Returns the idle delay stored in `storage`, or {@link DEFAULT_IDLE_DELAY} when none or an unknown one is. */
export function loadIdleDelay(storage: SettingsStorage): IdleDelay {
  return parseIdleDelay(storage.getItem(IDLE_DELAY_KEY));
}

/** Stores idle delay `delay` in `storage`. */
export function saveIdleDelay(storage: SettingsStorage, delay: IdleDelay): void {
  storage.setItem(IDLE_DELAY_KEY, idleDelayValue(delay));
}

/**
 * When the computer is kept from sleeping: never, while a session works, or
 * while a session works or waits for an answer.
 */
export type KeepAwake = "never" | "working" | "working-or-blocked";

/** Every keep-awake choice the settings dialog offers, in the order it lists them. */
export const KEEP_AWAKE_CHOICES: readonly KeepAwake[] = ["never", "working", "working-or-blocked"];

/** The keep-awake choice when none, or an unknown one, is stored. */
export const DEFAULT_KEEP_AWAKE: KeepAwake = "working-or-blocked";

/** The local storage key of the keep-awake choice. */
export const KEEP_AWAKE_KEY = "cloitre.keepAwake";

/** Returns the keep-awake choice `value` names, or {@link DEFAULT_KEEP_AWAKE} when it names none, `null` included. */
export function parseKeepAwake(value: string | null): KeepAwake {
  return KEEP_AWAKE_CHOICES.find((choice) => choice === value) ?? DEFAULT_KEEP_AWAKE;
}

/** Returns the keep-awake choice stored in `storage`, or {@link DEFAULT_KEEP_AWAKE} when none or an unknown one is. */
export function loadKeepAwake(storage: SettingsStorage): KeepAwake {
  return parseKeepAwake(storage.getItem(KEEP_AWAKE_KEY));
}

/** Stores keep-awake choice `choice` in `storage`. */
export function saveKeepAwake(storage: SettingsStorage, choice: KeepAwake): void {
  storage.setItem(KEEP_AWAKE_KEY, choice);
}
