import { app } from '../state/project.svelte';
import { parseDropTarget, type DropTarget } from './dropTarget';

/**
 * Moving cues around the grid, driven by raw pointer events rather than HTML5
 * drag-and-drop.
 *
 * Native DnD can't do this gesture reliably. A tile has to be draggable only
 * while a modifier is held — an unmodified press during a show fires the cue —
 * and `draggable` is read by the browser when the press lands, not when the
 * drag starts. That leaves the whole gesture riding on a `draggable` attribute
 * arriving before a mousedown Chrome has already begun classifying, and on
 * Chrome not deciding a modified press on a button is a selection gesture
 * instead. Both failed often enough to be worth leaving behind entirely.
 *
 * Pointer events have neither problem: the modifier is read from the press
 * itself, and nothing outside this file gets a say in whether the drag starts.
 *
 * External OS file drops still use native DnD — that's the only way to receive
 * them — so the grid listens for both.
 */

/**
 * How far the pointer must travel before a press becomes a drag. Small, because
 * the modifier has already said this is a drag; it exists only so a modified
 * click that wobbles a pixel doesn't land the cue in a neighbouring cell.
 */
const THRESHOLD = 4;

/**
 * Drop targets announce themselves with `data-drop`, and the carried tile is
 * hit-tested against whatever is under the pointer. Asking the document beats
 * per-target enter/leave handlers here: one lookup, and no target left stuck in
 * a hovered state because its leave event never arrived.
 */
function hitTest(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-drop]');
  return parseDropTarget(el?.getAttribute('data-drop') ?? null);
}

class CueDrag {
  /** The cue being carried, or null when nothing is in flight. */
  id = $state<string | null>(null);
  /** Pointer position, for the tile that follows it. */
  x = $state(0);
  y = $state(0);
  /** Ctrl held: this drop copies rather than moves. */
  copy = $state(false);
  /** Where releasing right now would put the cue. */
  target = $state<DropTarget | null>(null);

  /** A press that has a cue and a modifier but hasn't travelled far enough yet. */
  #pending: { id: string; x: number; y: number } | null = null;

  get dragging(): boolean {
    return this.id !== null;
  }

  overCell(row: number, col: number): boolean {
    return this.target?.kind === 'cell' && this.target.row === row && this.target.col === col;
  }
  overTab(id: string): boolean {
    return this.target?.kind === 'tab' && this.target.id === id;
  }

  /**
   * Offer a press to the drag: Shift or Alt to move, Ctrl to copy. Returns
   * whether it was taken — an unmodified press is a cue firing, not a drag.
   *
   * Taking the press doesn't cost the click. Shift-click opens properties and
   * shift-drag moves the cue, and the two can share a key because the click is
   * only swallowed once the press has actually travelled far enough to be a
   * drag. Under native DnD they couldn't: a shift-press was claimed by the drag
   * machinery whether or not it went anywhere.
   */
  press(cueId: string, e: PointerEvent): boolean {
    if (e.button !== 0 || (!e.shiftKey && !e.altKey && !e.ctrlKey)) return false;
    // Stops the press turning into a text selection or a focus change; the
    // click that follows is swallowed separately, on release.
    e.preventDefault();
    this.#pending = { id: cueId, x: e.clientX, y: e.clientY };
    this.copy = e.ctrlKey;
    window.addEventListener('pointermove', this.#move);
    window.addEventListener('pointerup', this.#up);
    window.addEventListener('pointercancel', this.#cancel);
    window.addEventListener('keydown', this.#key);
    window.addEventListener('keyup', this.#key);
    return true;
  }

  #move = (e: PointerEvent) => {
    const pending = this.#pending;
    if (!pending) return;
    this.x = e.clientX;
    this.y = e.clientY;
    this.copy = e.ctrlKey;
    if (!this.id) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < THRESHOLD) return;
      this.id = pending.id;
    }
    this.target = hitTest(e.clientX, e.clientY);
  };

  // Ctrl can be pressed or let go mid-drag, so the copy/move choice follows the
  // key rather than being fixed when the tile was picked up. Escape puts it back.
  #key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.#cancel();
      return;
    }
    this.copy = e.ctrlKey;
  };

  #up = (e: PointerEvent) => {
    const id = this.id;
    const target = this.target;
    const copy = e.ctrlKey;
    this.#cancel();
    if (!id) return;
    // The press became a drag, so the click it would otherwise end with must not
    // fire the cue. It arrives in the same task as this release, if at all.
    window.addEventListener('click', swallowClick, { capture: true });
    setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }));
    if (!target) return;
    if (target.kind === 'tab') app.moveCueToTab(id, target.id);
    else if (copy) app.copyCue(id, target.row, target.col);
    else app.moveCue(id, target.row, target.col);
  };

  #cancel = () => {
    this.#pending = null;
    this.id = null;
    this.target = null;
    window.removeEventListener('pointermove', this.#move);
    window.removeEventListener('pointerup', this.#up);
    window.removeEventListener('pointercancel', this.#cancel);
    window.removeEventListener('keydown', this.#key);
    window.removeEventListener('keyup', this.#key);
  };
}

function swallowClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
}

export const cueDrag = new CueDrag();
