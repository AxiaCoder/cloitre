import { invoke } from "@tauri-apps/api/core";

/** A project as Rust reports it. */
export interface Project {
  readonly id: number;
  /** The name of the project folder. */
  readonly name: string;
  /** The canonical path of the project folder. */
  readonly path: string;
  /** Whether that path still names a folder. */
  readonly exists: boolean;
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
