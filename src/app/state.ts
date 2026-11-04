import { commit, createHistory, redo, undo, type Change, type History, type Project } from "../core/index.ts";

/** Where Save writes to. A folder's handle and on-disk state live outside the reducer (Shell). */
export type SaveTarget = { readonly kind: "file"; readonly name: string } | { readonly kind: "folder"; readonly name: string };

export interface AppState {
  readonly history: History<Project>;
  /**
   * The project as it was last saved, opened or created. Because edits share structure,
   * "dirty" is a reference check, and undoing back to this state makes the project clean
   * again. null means the content exists nowhere else (recovered from the crash cache).
   */
  readonly saved: Project | null;
  /** Last open/save location; null until the project is saved. */
  readonly target: SaveTarget | null;
}

export type AppAction =
  | { readonly type: "commit"; readonly change: Change; readonly now: number }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  /** New, Open or Recover: replaces the project and clears the history. */
  | { readonly type: "replace"; readonly project: Project; readonly target: SaveTarget | null; readonly saved: boolean }
  /**
   * `project` is the version that was written. Folder saves are async, so the user may have
   * edited since; those later edits stay unsaved.
   */
  | { readonly type: "saved"; readonly project: Project; readonly target: SaveTarget };

export function initialState(project: Project): AppState {
  return { history: createHistory(project), saved: project, target: null };
}

export function isDirty(state: AppState): boolean {
  return state.saved === null || state.history.present !== state.saved;
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "commit":
      return { ...state, history: commit(state.history, action.change, action.now) };
    case "undo":
      return { ...state, history: undo(state.history) };
    case "redo":
      return { ...state, history: redo(state.history) };
    case "replace":
      return { history: createHistory(action.project), saved: action.saved ? action.project : null, target: action.target };
    case "saved":
      return { ...state, saved: action.project, target: action.target };
  }
}
