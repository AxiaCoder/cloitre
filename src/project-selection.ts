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

/**
 * Returns the project to start a session in after a click on project `clickedId`,
 * or `undefined` when none should start: an unknown project, a project whose
 * folder is gone, or the selected project while its session still runs.
 */
export function projectToStart(
  projects: readonly Project[],
  clickedId: number,
  selectedId: number | undefined,
  running: boolean,
): Project | undefined {
  const clicked = findProject(projects, clickedId);
  if (!clicked?.exists || (clickedId === selectedId && running)) {
    return undefined;
  }
  return clicked;
}
