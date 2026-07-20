// The shape of the colour inside a cue tile.
//
// A tile says what it is doing by how much of it is filled, in two stages that
// mean different things:
//
//   * A fade draws a wedge along the foot of the tile and fills it left to
//     right, like any other progress bar. The wedge's *slope* is the direction
//     of travel — rising into a fade-in, falling out of a fade-out — so the
//     shape says which way the level is going while the fill says how far along
//     it is. The empty wedge is drawn behind it, which is what makes the fill
//     legible as a proportion rather than as a blob that grows.
//   * Reaching full level fills the whole tile vertically, over ~100ms. That
//     step is deliberately a different motion from the fade it follows: the
//     wedge is "on its way", the solid card is "this is live", and an operator
//     scanning the grid needs those to be two looks, not two amounts of one. A
//     cue with no fade time shows only this stage, which is why a plain start
//     still reads as a tile filling in rather than as one blinking on.
//
// The three parts are kept separate — a static wedge, a horizontal sweep across
// it, and a vertical band over the whole tile — rather than being resolved into
// one polygon per frame. Composing them into a single shape was the obvious
// thing to do and it was wrong: `clip-path` only interpolates between polygons
// with matching point counts, so every stage had to be padded out to the same
// seven points, and the paths those points took between shapes were nobody's
// intent. Split apart, each stage animates one simple value — an `inset()` edge
// or an opacity — and the browser interpolates all of them correctly for free.

import type { PlaybackState } from '../types';

/** How tall the wedge stands at its high end, as a fraction of the tile. */
export const WEDGE_HEIGHT = 0.42;

/**
 * How long the band takes to rise or fall, in seconds.
 *
 * Not a decoration: the fades below are built around it, holding or filling
 * their wedge by exactly this much so the two shapes hand over cleanly. Which
 * is why the tile tweens the band from this constant rather than transitioning
 * it in CSS, and hands it to the stylesheet as `--commit` for the couple of
 * opacities that follow the same beat. One definition, and it is this one.
 */
export const COMMIT_TIME = 0.1;

/**
 * The shortest fade that gets a wedge at all.
 *
 * The commit animation eats COMMIT_TIME of any fade-out before the wedge starts
 * draining, so the wedge is only worth drawing if there is a useful amount of
 * fade left after it — hence *half as much again*, not "a hair over". Cutting
 * this fine went wrong twice over: a 0.1s fade left a drain of nothing at all,
 * which showed as a full wedge sitting through the whole fade and vanishing at
 * the end, and it wasn't even reliably detected, because the span is measured
 * off the audio clock and a fade asked for in exactly 0.1s comes back as
 * 0.10000000000000009. A threshold with room in it decides both.
 */
export const MIN_WEDGE_FADE = COMMIT_TIME * 1.5;

/** Which way the wedge slopes, i.e. which way the level is heading. */
export type Direction = 'up' | 'down';

/** What the tile's fill looks like right now. */
export interface Fill {
  /** How far the wedge has been swept, 0..1. */
  progress: number;
  /** Height of the full-width band over it: 0 while fading, 1 when live. */
  band: number;
  direction: Direction;
}

/** 0..1, and 0 for anything that isn't a number at all — a NaN would travel
 *  intact through Math.min/max and come out the far end as an invalid
 *  clip-path, which paints nothing and gives no hint as to why. */
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

/**
 * The wedge itself: a triangle along the foot of the tile, rising to
 * WEDGE_HEIGHT at the end it is heading toward.
 *
 * Fixed for a given direction — it never animates, and a wedge that flipped
 * while it was on screen would read as the level reversing. Whose job it is to
 * make sure the flip is never seen belongs to the caller: see `direction` in
 * CueButton, which holds the last fade's lean until the ghost has gone.
 */
export function wedgePath(direction: Direction): string {
  const high = pct(1 - WEDGE_HEIGHT);
  return direction === 'up'
    ? `polygon(0% 100%, 100% ${high}, 100% 100%)`
    : `polygon(0% ${high}, 100% 100%, 0% 100%)`;
}

/**
 * How much of the wedge is currently solid, as a clip on top of it. `progress`
 * is how much colour there is, so it runs up during a fade-in and down during a
 * fade-out.
 *
 * Both sweeps travel left to right; only what they leave behind differs. A
 * fade-in lays colour down as it goes, so it is clipped from the right and the
 * solid edge advances. A fade-out takes colour away as it goes, so it is
 * clipped from the *left* and what follows the edge is the ghost — the level
 * being handed back rather than the fill retreating the way it came.
 *
 * That both run the same way matters more than it looks: an operator reading a
 * wall of tiles is looking at the moving edge, and an edge that meant "coming
 * up" going one way and "going out" going the other would be a detail to work
 * out on every glance. Direction is carried by the wedge's slope and by which
 * side of the edge holds the colour, both of which are legible at a standstill.
 */
export function sweepPath(progress: number, direction: Direction): string {
  const empty = pct(1 - clamp(progress));
  const zero = pct(0);
  return direction === 'up'
    ? `inset(${zero} ${empty} ${zero} ${zero})`
    : `inset(${zero} ${zero} ${zero} ${empty})`;
}

/**
 * The band: the tile committing to being live, or letting go of it. Rises from
 * the foot of the tile and falls back the same way.
 *
 * Its top edge stays flat the whole way up. It would be natural to grow the
 * wedge itself into a full card — it is right there, and the shapes share an
 * edge — but that puts the commit on a slant, and a slanted edge is the one
 * thing on the tile that already means something: which way the level is going.
 * Keeping the band level makes it a different kind of movement from the fade it
 * follows, which is the whole point of it being a separate stage.
 */
export function bandPath(band: number): string {
  const zero = pct(0);
  return `inset(${pct(1 - clamp(band))} ${zero} ${zero} ${zero})`;
}

/**
 * Whether a fade of this many seconds is long enough to be worth a wedge.
 *
 * Below MIN_WEDGE_FADE there is nothing to draw: the wedge would have to
 * appear, sweep and leave in about the time the band alone takes to rise, so it
 * reads as a flicker under the tile rather than as a level on its way
 * somewhere. A cut has always been the band alone; a fade this short is a cut
 * as far as the eye is concerned, and showing it as one keeps the wedge meaning
 * "there is time to watch this happen".
 */
export function wedgeWorthDrawing(fadeSeconds: number): boolean {
  return fadeSeconds > MIN_WEDGE_FADE;
}

/**
 * How much of the wedge a fade-in has laid down, 0..1.
 *
 * Full a commit's length *before* the fade lands, which is what lets the band
 * start rising there and finish on time. Sweeping right up to the end instead
 * put the whole commit after the audio was already at level, so the tile
 * announced a cue that had finished arriving.
 *
 * The wedge therefore runs slightly ahead of the audible level, exactly as it
 * runs behind on the way out. Both are the same trade, and it is the right way
 * round: what the wedge is for is telling an operator where the level is
 * *heading*, so it belongs at the end it is heading toward.
 */
function swept(fade: number, fadeSeconds: number): number {
  const span = fadeSeconds - COMMIT_TIME;
  if (span <= 0) return 1;
  return clamp((clamp(fade) * fadeSeconds) / span);
}

/**
 * How much of the wedge a fade-out has taken away, 0..1.
 *
 * The drain doesn't start with the fade: the band has to get out of the way
 * first, and it takes COMMIT_TIME to do it. Draining underneath it would mean
 * the wedge came out from under a collapsing band already part-empty, so the
 * one moment where both shapes are on screen at once would be the one where
 * they disagree about how much level is left. Held full through the collapse,
 * the band lands *on* a full wedge and the wedge takes over from there — one
 * reading handed to the next, which is the same handover as a fade-in's, run
 * backwards.
 *
 * The cost is that the wedge trails the audible level by a fixed 100ms for the
 * rest of the fade. On the fades this is drawn for at all — anything longer
 * than the collapse itself — that is a small enough share of the whole to be
 * worth an unambiguous handover.
 */
function drained(fade: number, fadeSeconds: number): number {
  const span = fadeSeconds - COMMIT_TIME;
  if (span <= 0) return 1;
  return clamp((clamp(fade) * fadeSeconds - COMMIT_TIME) / span);
}

/**
 * How a tile in the given playback state is filled.
 *
 * `fade` is the engine's fade progress, 0..1, counted the same way for both
 * directions: 0 when the fade starts, 1 when it lands, and `fadeSeconds` is how
 * long that fade was asked to take. A fade-out is emptying while its progress
 * fills, which is why it inverts here.
 *
 * A fade too short to draw a wedge for is filled as its *destination* rather
 * than as its current state, which puts the band's rise or fall over the fade
 * itself instead of after it — so the tile lands at the same moment the audio
 * does, and the whole gesture is one movement rather than a flicker followed by
 * one.
 *
 * A playing cue keeps a fully swept wedge under its band, so the collapse into
 * a fade-out has a full wedge to land on rather than one that has to catch up
 * from empty. Nothing of it shows: the wedge is only *drawn* while a fade is
 * being drawn — see the opacity gate in CueButton, without which every cut put
 * a triangle on screen for the 100ms its band spent rising past it.
 *
 * The direction returned for the states that aren't fading is a placeholder —
 * nothing of the wedge is visible in either — and the caller overrides it; see
 * `direction` in CueButton.
 */
export function fillFor(state: PlaybackState, fade: number, fadeSeconds: number): Fill {
  const wedge = wedgeWorthDrawing(fadeSeconds);
  const shown = wedge
    ? state
    : state === 'fadingIn'
      ? 'playing'
      : state === 'fadingOut'
        ? 'idle'
        : state;
  switch (shown) {
    case 'playing':
      return { progress: 1, band: 1, direction: 'up' };
    case 'fadingIn': {
      // A full wedge is the cue's signal to commit: the band goes up the moment
      // the sweep lands, a commit's length before the fade does, so the two
      // finish together. Holding it at 0 until the engine flips the state would
      // be the same 100ms of animation starting 100ms too late.
      const laid = swept(fade, fadeSeconds);
      return { progress: laid, band: laid >= 1 ? 1 : 0, direction: 'up' };
    }
    case 'fadingOut':
      return { progress: 1 - drained(fade, fadeSeconds), band: 0, direction: 'down' };
    default:
      return { progress: 0, band: 0, direction: 'up' };
  }
}
