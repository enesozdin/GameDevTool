/** Minimal result type, so expected failures (bad files, limits) are values, not exceptions. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}

/** Path to a value inside a project, e.g. ["assets", 3, "rows", 10, "cells", "<columnId>"]. */
export type IssuePath = readonly (string | number)[];

/**
 * A validation finding. Core never produces user-facing text: `code` is a stable
 * identifier and `params` holds the values the UI needs to build a localized message.
 */
export interface Issue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: IssuePath;
  readonly params?: Readonly<Record<string, string | number>>;
}
