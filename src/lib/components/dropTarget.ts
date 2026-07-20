/**
 * Where a dragged cue can land. Targets mark themselves in the DOM with a
 * `data-drop` attribute and the drag hit-tests whatever is under the pointer,
 * so this string is the whole contract between the two — hence its own module,
 * free of app state and testable on its own.
 */
export type DropTarget =
  | { kind: 'cell'; row: number; col: number }
  | { kind: 'tab'; id: string };

/** `cell:<row>:<col>` or `tab:<id>`; anything else is not a drop target. */
export function parseDropTarget(spec: string | null): DropTarget | null {
  if (!spec) return null;
  // Sliced rather than split, because a tab id is free to contain a colon.
  if (spec.startsWith('tab:')) return spec.length > 4 ? { kind: 'tab', id: spec.slice(4) } : null;
  const cell = /^cell:(\d+):(\d+)$/.exec(spec);
  return cell ? { kind: 'cell', row: +cell[1], col: +cell[2] } : null;
}
