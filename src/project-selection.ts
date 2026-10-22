import type { Project } from "./projects";

/** What the work area shows. */
export type WorkArea =
  | { readonly kind: "empty" }
  | { readonly kind: "missing"; readonly project: Project }
  | { readonly kind: "terminal" };

/** Returns the project with `id`, or `undefined` when `id` is unset or unknown. */
export function findProject(projects: readonly Project[], id: number | undefined): Project | undefined {
  return id === undefined ? undefined : projects.find((project) => project.id === id);
}

/** Returns `selectedId` when it still names one of `projects`, `undefined` otherwise. */
export function keepSelection(projects: readonly Project[], selectedId: number | undefined): number | undefined {
  return findProject(projects, selectedId)?.id;
}

/**
 * Chooses what the work area shows: the empty state when there is no project,
 * the missing-folder state when the selected project's folder is gone, the
 * terminal otherwise (with or without a selected project).
 */
export function chooseWorkArea(projects: readonly Project[], selectedId: number | undefined): WorkArea {
  if (projects.length === 0) {
    return { kind: "empty" };
  }
  const selected = findProject(projects, selectedId);
  if (selected && !selected.exists) {
    return { kind: "missing", project: selected };
  }
  return { kind: "terminal" };
}

/** What a click on a project does to its tabs. */
export type ClickAction =
  | { readonly kind: "none" }
  | { readonly kind: "missing" }
  | { readonly kind: "show" }
  | { readonly kind: "open"; readonly project: Project };

/**
 * Chooses what a click on project `clickedId` does: nothing for an unknown
 * project, the missing-folder state for a project whose folder is gone, its
 * active tab when it has tabs (even one still starting), a new tab otherwise.
 */
export function clickAction(projects: readonly Project[], clickedId: number, hasTabs: boolean): ClickAction {
  const clicked = findProject(projects, clickedId);
  if (!clicked) {
    return { kind: "none" };
  }
  if (!clicked.exists) {
    return { kind: "missing" };
  }
  return hasTabs ? { kind: "show" } : { kind: "open", project: clicked };
}
