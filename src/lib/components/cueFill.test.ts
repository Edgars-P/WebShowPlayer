// The shape a tile fills with. Its job is to be readable at a glance across a
// wall of tiles, which comes down to a few properties: a fade never appears to
// run backwards, the wedge's slope always points the way the level is heading,
// and each stage hands over to the next without the tile jumping between them.

import { describe, expect, it } from 'vitest';
import {
  bandPath,
  COMMIT_TIME,
  fillFor,
  MIN_WEDGE_FADE,
  sweepPath,
  wedgePath,
  wedgeWorthDrawing,
  WEDGE_HEIGHT,
} from './cueFill';

/** A fade with plenty of time in it — long enough to be drawn as one. */
const LONG = 3;
/** No fade at all: an instant start or stop. */
const CUT = 0;

/** The percentages in a CSS value, in order. */
const nums = (css: string) => (css.match(/-?[\d.]+(?=%)/g) ?? []).map(Number);

describe('wedgePath', () => {
  it('stands at its full height on the side it is heading toward', () => {
    // y is measured down the tile, so the high end is the smallest number.
    const up = nums(wedgePath('up'));
    const down = nums(wedgePath('down'));
    const high = (1 - WEDGE_HEIGHT) * 100;

    // Rising: high at x=100%.
    expect(wedgePath('up')).toContain(`100% ${high.toFixed(2)}%`);
    // Falling: high at x=0.
    expect(wedgePath('down')).toContain(`0% ${high.toFixed(2)}%`);
    // Both are triangles sitting on the foot of the tile.
    expect(up.filter((n) => n === 100)).not.toHaveLength(0);
    expect(down.filter((n) => n === 100)).not.toHaveLength(0);
  });

  it('is the same wedge either way up', () => {
    expect(wedgePath('up')).not.toBe(wedgePath('down'));
    // Same three corners, mirrored: the peak sits at the same height.
    const peak = (css: string) => Math.min(...nums(css).filter((_, i) => i % 2 === 1));
    expect(peak(wedgePath('up'))).toBeCloseTo(peak(wedgePath('down')), 6);
  });

  it('never reaches the top of the tile — a wedge is not a full card', () => {
    for (const dir of ['up', 'down'] as const) {
      const ys = nums(wedgePath(dir)).filter((_, i) => i % 2 === 1);
      expect(Math.min(...ys)).toBeGreaterThan(0);
    }
  });
});

describe('sweepPath', () => {
  // inset(top right bottom left).
  const right = (css: string) => nums(css)[1];
  const left = (css: string) => nums(css)[3];

  it('shows none of the wedge when empty and all of it when full', () => {
    for (const dir of ['up', 'down'] as const) {
      expect(nums(sweepPath(1, dir))).toEqual([0, 0, 0, 0]);
      // Empty: clipped away entirely, from whichever side that direction uses.
      expect(Math.max(...nums(sweepPath(0, dir)))).toBe(100);
    }
  });

  it('lays colour down from the left as a fade-in progresses', () => {
    let last = Infinity;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const css = sweepPath(p, 'up');
      expect(left(css)).toBe(0); // never clipped from the left
      expect(right(css)).toBeLessThanOrEqual(last);
      last = right(css);
    }
  });

  it('takes colour away from the left as a fade-out progresses', () => {
    // `progress` is how much colour is left, so it counts *down* through a
    // fade-out — and the edge doing the eating still travels left to right.
    let last = -Infinity;
    for (let remaining = 1; remaining >= -0.0001; remaining -= 0.1) {
      const css = sweepPath(remaining, 'down');
      expect(right(css)).toBe(0); // never clipped from the right
      expect(left(css)).toBeGreaterThanOrEqual(last);
      last = left(css);
    }
  });

  it('sweeps the same way for both fades, keeping the colour on opposite sides', () => {
    // Half way through either fade, the moving edge is in the middle. What
    // differs is which side of it is solid.
    expect(right(sweepPath(0.5, 'up'))).toBe(50);
    expect(left(sweepPath(0.5, 'down'))).toBe(50);
  });
});

describe('bandPath', () => {
  it('is empty at rest and covers the tile when live', () => {
    expect(nums(bandPath(0))[0]).toBe(100);
    expect(nums(bandPath(1))).toEqual([0, 0, 0, 0]);
  });

  it('rises from the foot of the tile on a level edge', () => {
    // Only the top edge moves: the band never inherits the wedge's slant, which
    // is the one thing on the tile that carries a meaning of its own.
    const [top, right, bottom, left] = nums(bandPath(0.25));
    expect(top).toBe(75);
    expect([right, bottom, left]).toEqual([0, 0, 0]);
  });

  it('grows as the cue commits', () => {
    let last = Infinity;
    for (let b = 0; b <= 1.0001; b += 0.1) {
      const top = nums(bandPath(b))[0];
      expect(top).toBeLessThanOrEqual(last);
      last = top;
    }
  });
});

describe('clamping', () => {
  it('keeps nonsense out of the CSS', () => {
    // A NaN would travel intact through Math.min/max and land in the stylesheet
    // as an invalid clip-path, which paints nothing and says nothing about why.
    for (const junk of [NaN, Infinity, -Infinity, -5, 42]) {
      for (const css of [sweepPath(junk, 'up'), sweepPath(junk, 'down'), bandPath(junk)]) {
        for (const n of nums(css)) {
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe('wedgeWorthDrawing', () => {
  it('takes a fade with no room to drain in for a cut', () => {
    // A wedge that appeared, swept and left in about the time the band alone
    // takes to rise is a flicker, not a level going somewhere.
    expect(wedgeWorthDrawing(0)).toBe(false);
    expect(wedgeWorthDrawing(COMMIT_TIME / 2)).toBe(false);
    expect(wedgeWorthDrawing(COMMIT_TIME)).toBe(false);
    expect(wedgeWorthDrawing(MIN_WEDGE_FADE)).toBe(false);
  });

  it('leaves margin for a fade span measured off the audio clock', () => {
    // The span comes back as a difference of two clock readings, so a fade
    // asked for in exactly the commit time arrives a hair over it. Deciding
    // this on floating-point noise is what left a 0.1s fade-out showing a full
    // wedge for its whole length and then popping.
    expect(wedgeWorthDrawing(0.10000000000000009)).toBe(false);
  });

  it('draws one for any fade with real time in it', () => {
    expect(wedgeWorthDrawing(MIN_WEDGE_FADE * 1.01)).toBe(true);
    expect(wedgeWorthDrawing(0.5)).toBe(true);
    expect(wedgeWorthDrawing(3)).toBe(true);
  });
});

describe('fillFor', () => {
  it('fills a playing cue and empties an idle one', () => {
    expect(fillFor('playing', 0, CUT)).toEqual({ progress: 1, band: 1, direction: 'up' });
    expect(fillFor('idle', 1, CUT)).toEqual({ progress: 0, band: 0, direction: 'up' });
  });

  it('sweeps a rising wedge as a fade-in progresses', () => {
    expect(fillFor('fadingIn', 0, LONG)).toEqual({ progress: 0, band: 0, direction: 'up' });
    expect(fillFor('fadingIn', 0.5, LONG)).toEqual({ progress: 0.5, band: 0, direction: 'up' });
    expect(fillFor('fadingIn', 1, LONG)).toEqual({ progress: 1, band: 0, direction: 'up' });
  });

  it('hands a finished fade-in to the live state with only the band moving', () => {
    // The instant a fade-in completes, the cue flips to `playing` and the band
    // rises. Nothing else may change in that frame: a wedge that also slid or
    // flipped would read as a second thing happening.
    const done = fillFor('fadingIn', 1, LONG);
    const live = fillFor('playing', 0, LONG);
    expect(live.progress).toBe(done.progress);
    expect(live.direction).toBe(done.direction);
    expect(live.band).toBeGreaterThan(done.band);
  });

  it('lands a finished fade-out on the same shape as idle', () => {
    expect(fillFor('fadingOut', 1, LONG).progress).toBe(fillFor('idle', 0, LONG).progress);
    expect(fillFor('fadingOut', 1, LONG).band).toBe(fillFor('idle', 0, LONG).band);
  });

  it('tells the two fades apart by their slope', () => {
    expect(fillFor('fadingIn', 0.5, LONG).direction).toBe('up');
    expect(fillFor('fadingOut', 0.5, LONG).direction).toBe('down');
  });

  describe('a fade-out', () => {
    /** How far through a `seconds`-long fade `at` seconds is. */
    const after = (at: number, seconds: number) => at / seconds;

    it('starts from a full wedge, so the band has something to fall to', () => {
      const live = fillFor('playing', 0, LONG);
      const leaving = fillFor('fadingOut', 0, LONG);
      expect(live.progress).toBe(leaving.progress);
      // Only the band drops; the wedge underneath is already fully swept and just
      // changes which way it leans — which happens while the band still covers it.
      expect(leaving.band).toBeLessThan(live.band);
    });

    it('holds that wedge full until the band has finished collapsing', () => {
      // The one moment both shapes are on screen is the handover, and they must
      // not disagree about how much level is left while it happens.
      for (const at of [0, COMMIT_TIME / 3, COMMIT_TIME]) {
        expect(fillFor('fadingOut', after(at, LONG), LONG).progress).toBe(1);
      }
    });

    it('drains over whatever the fade has left after that', () => {
      // Half of the post-collapse span gone, half the wedge gone with it.
      const half = COMMIT_TIME + (LONG - COMMIT_TIME) / 2;
      expect(fillFor('fadingOut', after(half, LONG), LONG).progress).toBeCloseTo(0.5, 6);
    });

    it('empties exactly as the fade lands, never before', () => {
      let last = Infinity;
      for (let p = 0; p < 1; p += 0.05) {
        const { progress } = fillFor('fadingOut', p, LONG);
        expect(progress).toBeLessThanOrEqual(last); // only ever emptying
        expect(progress).toBeGreaterThan(0); // there is still level to give back
        last = progress;
      }
      expect(fillFor('fadingOut', 1, LONG).progress).toBe(0);
    });
  });

  describe('a fade too short to draw', () => {
    // There is no time to show a wedge in one of these. Such a fade is filled
    // as its destination instead, so the band's rise or fall *is* the animation
    // and lands with the audio.
    for (const seconds of [CUT, COMMIT_TIME / 2, COMMIT_TIME, MIN_WEDGE_FADE]) {
      it(`is the band alone at ${seconds}s`, () => {
        for (const p of [0, 0.5, 1]) {
          expect(fillFor('fadingIn', p, seconds)).toEqual(fillFor('playing', p, seconds));
          expect(fillFor('fadingOut', p, seconds)).toEqual(fillFor('idle', p, seconds));
        }
      });
    }

    it('never leaves a wedge under a rising band', () => {
      // The bug this is here for: a cut kept its wedge fully swept while the
      // band rose past it, putting a triangle on screen for 100ms every time.
      const cutIn = fillFor('fadingIn', 0.5, CUT);
      expect(cutIn.band).toBe(1);
      // The wedge is still swept — it's hidden by opacity, not by emptying it,
      // so that a later fade-out has a full one to collapse onto.
      expect(cutIn.progress).toBe(1);
    });
  });

  it('keeps a nonsense fade progress inside the tile', () => {
    expect(fillFor('fadingIn', NaN, LONG).progress).toBe(0);
    expect(fillFor('fadingIn', 5, LONG).progress).toBe(1);
    expect(fillFor('fadingOut', NaN, LONG).progress).toBe(1);
    expect(fillFor('fadingOut', -3, LONG).progress).toBe(1);
  });
});
