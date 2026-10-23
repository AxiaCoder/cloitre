import { invoke } from "@tauri-apps/api/core";

/** A tab of a project, as Rust keeps it between runs. */
export interface ProjectTab {
  /** Unique across every project, from 1, never reused. */
  readonly id: number;
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
}

/** Every project, with the warning Rust gives when the saved list could not be loaded. */
export interface ProjectList {
  readonly projects: readonly Project[];
  readonly warning: string | null;
}

/** Lists every project, in the order they were added. Never rejects on the Rust side. */
export function listProjects(): Promise<ProjectList> {
  return invoke<ProjectList>("project_list");
}

/**
 * Opens the folder picker and adds the chosen folder as a project.
 * Resolves with that project (the existing one when the folder already is a
 * project), or `null` when the picker is cancelled. Rejects with the Rust
 * refusal message.
 */
export function addProject(): Promise<Project | null> {
  return invoke<Project | null>("project_add");
}

/**
 * Opens the folder picker and moves project `id` to the chosen folder.
 * Resolves with the moved project, or `null` when the picker is cancelled.
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
