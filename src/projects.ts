import { invoke } from "@tauri-apps/api/core";

/** A tab of a project, as Rust keeps it between runs. */
export interface ProjectTab {
  /** Unique across every project, from 1, never reused. */
  readonly id: number;
  /** The title its session last set, or `null` when it set none. */
  readonly title: string | null;
}

/** A project as Rust reports it. */
export interface Project {
  readonly id: number;
  /** The name of the project folder. */
  readonly name: string;
  /** The canonical path of the project folder. */
  readonly path: string;
  /** Whether that path still names a folder. */
  readonly exists: boolean;
  /** Its tabs, in opening order. */
  readonly tabs: readonly ProjectTab[];
  /** The tab to bring to the front: the last active one while it exists, else the first tab, else `null` with no tab. */
  readonly activeTab: number | null;
  /** The marker color, a name of the marker catalog, or `null` for no color. */
  readonly color: string | null;
  /** The marker icon, a name of the marker catalog, or `null` for the initials. */
  readonly icon: string | null;
}

/** Every project, with the warning Rust gives when the saved list could not be loaded. */
export interface ProjectList {
  readonly projects: readonly Project[];
  readonly warning: string | null;
  /** The project to select: the last remembered one while it exists, else the first, else `null` with no project. */
  readonly selected: number | null;
}

/** Lists every project, in the order they were added. Never rejects on the Rust side. */
export function listProjects(): Promise<ProjectList> {
  return invoke<ProjectList>("project_list");
}

/**
 * Opens the folder picker and adds the chosen folder as a project.
 * Resolves with that project (the existing one when the folder already is a
 * project), or `null` when the picker is cancelled or another folder picker
 * is already open. Rejects with the Rust
 * refusal message.
 */
export function addProject(): Promise<Project | null> {
  return invoke<Project | null>("project_add");
}

/**
 * Opens the folder picker and moves project `id` to the chosen folder.
 * Resolves with the moved project, or `null` when the picker is cancelled or
 * another folder picker is already open.
 * Rejects with the Rust refusal message, for instance when the folder is
 * already another project's.
 */
export function relocateProject(id: number): Promise<Project | null> {
  return invoke<Project | null>("project_relocate", { id });
}

/** Removes project `id`. Rejects with the Rust refusal message. */
export function removeProject(id: number): Promise<void> {
  return invoke("project_remove", { id });
}

/**
 * Remembers project `id` as the selected one, for the next run. Rejects with
 * the Rust refusal message: an unknown id, a failed save.
 */
export function rememberSelection(id: number): Promise<void> {
  return invoke("project_select", { id });
}

/**
 * Gives project `id` the marker color `color`, `null` for no color, and the
 * marker icon `icon`, `null` for the initials; both are names of the marker
 * catalog, chosen independently. Resolves with the updated project; rejects
 * with the Rust refusal message.
 */
export function setProjectMarker(id: number, color: string | null, icon: string | null): Promise<Project> {
  return invoke<Project>("project_set_marker", { id, color, icon });
}

/**
 * Remembers tab `tabId` as the active tab of its project, for the next run.
 * Rejects with the Rust refusal message: an unknown tab id, a failed save.
 */
export function rememberActiveTab(tabId: number): Promise<void> {
  return invoke("tab_activate", { tabId });
}

/**
 * Saves `title` as the title of tab `tabId`, `null` to clear it. Rejects with
 * the Rust refusal message: a title longer than 256 characters or holding a
 * control character, an unknown tab id, a read-only project list, a failed save.
 */
export function saveTabTitle(tabId: number, title: string | null): Promise<void> {
  return invoke("tab_set_title", { tabId, title });
}

/**
 * Opens a new tab in project `projectId` and saves it. Starts no session.
 * Resolves with the tab; rejects with the Rust refusal message.
 */
export function openTab(projectId: number): Promise<ProjectTab> {
  return invoke<ProjectTab>("tab_open", { projectId });
}

/**
 * Removes tab `tabId` from its project's saved tabs. Does not stop its
 * session: the caller kills it first. Rejects with the Rust refusal message.
 */
export function closeTab(tabId: number): Promise<void> {
  return invoke("tab_close", { tabId });
}
