// The optimized loudness measurement must agree with a plain, obvious
// transcription of BS.1770 — the two refinements in loudness.ts (cascading both
// biquads in one pass, and summing 100 ms hops once instead of re-summing each
// 75%-overlapped 400 ms block) are pure performance work and must not move the
// gain at all.

import { describe, expect, it } from 'vitest';
import { measureNormalizeGain } from './loudness';

// ---- Reference implementation (direct, unoptimized) ------------------------

const TARGET_LUFS = -14;
const ABS_GATE_LUFS = -70;
const REL_GATE_LU = -10;
const BLOCK_SEC = 0.4;
const HOP_SEC = 0.1;
const PEAK_CEIL = 0.99;
const MIN_NORM_GAIN = 0.1;
const MAX_NORM_GAIN = 16;
const MIN_LEVEL = 0.0001;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function kWeighting(fs: number): [Biquad, Biquad] {
  const K1 = Math.tan((Math.PI * 1681.9744509555319) / fs);
  const Q1 = 0.7071752369554193;
  const Vh = Math.pow(10, 3.99984385397 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K1 / Q1 + K1 * K1;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K1) / Q1 + K1 * K1) / a0,
    b1: (2 * (K1 * K1 - Vh)) / a0,
    b2: (Vh - (Vb * K1) / Q1 + K1 * K1) / a0,
    a1: (2 * (K1 * K1 - 1)) / a0,
    a2: (1 - K1 / Q1 + K1 * K1) / a0,
  };
  const K2 = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  const d = 1 + K2 / Q2 + K2 * K2;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K2 * K2 - 1)) / d,
    a2: (1 - K2 / Q2 + K2 * K2) / d,
  };
  return [shelf, hp];
}

function filterInPlace(x: Float32Array, f: Biquad): void {
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

/** Straightforward BS.1770: filter each stage separately, sum each block directly. */
function referenceGain(input: Float32Array[], fs: number): number {
  const len = input[0].length;
  const block = Math.round(BLOCK_SEC * fs);

  let peak = 0;
  for (const d of input) {
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
    }
  }
  if (len < block) return 1;

  const [shelf, hp] = kWeighting(fs);
  const chans = input.map((c) => {
    const y = new Float32Array(c);
    filterInPlace(y, shelf);
    filterInPlace(y, hp);
    return y;
  });

  const hop = Math.round(HOP_SEC * fs);
  // Mono is measured as the dual-mono pair the browser will up-mix it into, so
  // that a mono file and its stereo twin normalize to the same level.
  const upmix = chans.length === 1 ? 2 : 1;
  const z: number[] = [];
  for (let start = 0; start + block <= len; start += hop) {
    let sum = 0;
    for (const d of chans) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += d[i] * d[i];
      sum += s / block;
    }
    z.push(sum * upmix);
  }

  const loud = (ms: number) => -0.691 + 10 * Math.log10(ms);
  let sum = 0,
    n = 0;
  for (const ms of z) if (ms > 0 && loud(ms) >= ABS_GATE_LUFS) (sum += ms), n++;
  if (n === 0) return 1;
  const relThresh = loud(sum / n) + REL_GATE_LU;
  sum = 0;
  n = 0;
  for (const ms of z) {
    if (ms > 0 && loud(ms) >= ABS_GATE_LUFS && loud(ms) >= relThresh) (sum += ms), n++;
  }
  if (n === 0) return 1;
  const lufs = loud(sum / n);

  const loudGain = Math.pow(10, (TARGET_LUFS - lufs) / 20);
  const peakGain = peak > MIN_LEVEL ? PEAK_CEIL / peak : MAX_NORM_GAIN;
  return Math.min(MAX_NORM_GAIN, Math.max(MIN_NORM_GAIN, Math.min(loudGain, peakGain)));
}

// ---- Signal generators -----------------------------------------------------

type Kind = 'sine1k' | 'bass60' | 'noise' | 'quiet' | 'dynamic' | 'clipped' | 'silence';

function makeSignal(kind: Kind, fs: number, seconds: number, channels: number): Float32Array[] {
  const n = Math.floor(fs * seconds);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  return Array.from({ length: channels }, () => {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      switch (kind) {
        case 'sine1k':
          d[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * t);
          break;
        case 'bass60':
          d[i] = 0.8 * Math.sin(2 * Math.PI * 60 * t);
          break;
        case 'noise':
          d[i] = 0.3 * rnd();
          break;
        case 'quiet':
          d[i] = 0.02 * Math.sin(2 * Math.PI * 440 * t);
          break;
        case 'dynamic': {
          // Loud chorus alternating with a near-silent verse, to exercise gating.
          const loud = Math.floor(t / 5) % 2 === 0;
          d[i] = (loud ? 0.7 : 0.005) * Math.sin(2 * Math.PI * 300 * t) + 0.05 * rnd();
          break;
        }
        case 'clipped':
          d[i] = Math.max(-0.999, Math.min(0.999, 2.5 * Math.sin(2 * Math.PI * 200 * t)));
          break;
        case 'silence':
          d[i] = 0;
          break;
      }
    }
    return d;
  });
}

// ---- Tests -----------------------------------------------------------------

describe('measureNormalizeGain', () => {
  const cases: [Kind, number, number, number][] = [
    ['sine1k', 44100, 30, 2],
    ['bass60', 44100, 30, 2],
    ['noise', 44100, 30, 2],
    ['quiet', 44100, 20, 1],
    ['dynamic', 44100, 60, 2],
    ['clipped', 48000, 20, 2],
    ['sine1k', 48000, 12, 1],
    ['noise', 22050, 8, 2],
  ];

  it.each(cases)('matches the reference implementation: %s @%iHz %is %ich', (kind, fs, secs, ch) => {
    const src = makeSignal(kind, fs, secs, ch);
    const expected = referenceGain(
      src.map((c) => new Float32Array(c)),
      fs,
    );
    const actual = measureNormalizeGain(
      src.map((c) => new Float32Array(c)),
      fs,
    );
    // Not bit-identical, and deliberately so: the reference writes each filter
    // stage back into a Float32Array, quantizing between the shelf and the
    // high-pass, while the optimized version cascades both stages in float64
    // and only ever reads float32. That makes it marginally *more* accurate,
    // and the two land within ~1e-9 of each other — call it 1e-8 dB, some seven
    // orders of magnitude below the smallest level change anyone can hear.
    const differenceDb = Math.abs(20 * Math.log10(actual / expected));
    expect(differenceDb).toBeLessThan(0.0001);
  });

  describe('mono vs stereo', () => {
    // Web Audio up-mixes a mono source to L = R at full amplitude, so a mono
    // file and a dual-mono stereo file of the same content are acoustically
    // identical at playback and must normalize to the same gain. Measuring the
    // stored channels naively gives the stereo copy twice the mean-square
    // (+3.01 dB) and so hands the mono copy ~3 dB more gain — audible, and
    // exactly what the up-mix weighting exists to prevent.
    const kinds: Kind[] = ['sine1k', 'bass60', 'noise', 'dynamic'];

    it.each(kinds)('normalizes mono and dual-mono stereo identically: %s', (kind) => {
      const [chan] = makeSignal(kind, 44100, 20, 1);
      const mono = measureNormalizeGain([new Float32Array(chan)], 44100);
      const stereo = measureNormalizeGain(
        [new Float32Array(chan), new Float32Array(chan)],
        44100,
      );
      expect(mono).toBeCloseTo(stereo, 10);
    });

    it('would have been 3 dB apart without the up-mix weighting', () => {
      // Guards the fix itself: strip the weighting out (by measuring the mono
      // signal as a "stereo" pair where one channel is silent, which is what
      // one channel of energy looks like to BS.1770) and the gap reappears.
      const [chan] = makeSignal('noise', 44100, 20, 1);
      const silent = new Float32Array(chan.length);
      const unweighted = measureNormalizeGain([new Float32Array(chan), silent], 44100);
      const weighted = measureNormalizeGain([new Float32Array(chan)], 44100);
      const gapDb = 20 * Math.log10(unweighted / weighted);
      expect(gapDb).toBeCloseTo(3.01, 1);
    });
  });

  it('quietens a loud track and lifts a quiet one', () => {
    const loud = measureNormalizeGain(makeSignal('sine1k', 44100, 20, 2), 44100);
    const quiet = measureNormalizeGain(makeSignal('quiet', 44100, 20, 2), 44100);
    expect(loud).toBeLessThan(1);
    expect(quiet).toBeGreaterThan(1);
  });

  it('never lets a normalized track clip at full volume', () => {
    // A track already peaking near full scale must not be pushed above it.
    const src = makeSignal('quiet', 44100, 20, 1);
    src[0][0] = 0.98; // a lone near-full-scale transient
    const gain = measureNormalizeGain(src, 44100);
    expect(gain * 0.98).toBeLessThanOrEqual(1);
  });

  it('leaves silence and unmeasurably short clips alone', () => {
    expect(measureNormalizeGain(makeSignal('silence', 44100, 5, 2), 44100)).toBe(1);
    // Shorter than one 400 ms gating block.
    expect(measureNormalizeGain(makeSignal('sine1k', 44100, 0.2, 2), 44100)).toBe(1);
    expect(measureNormalizeGain([], 44100)).toBe(1);
  });

  it('stays within the configured gain bounds', () => {
    for (const kind of ['sine1k', 'bass60', 'noise', 'quiet', 'dynamic', 'clipped'] as Kind[]) {
      const gain = measureNormalizeGain(makeSignal(kind, 44100, 15, 2), 44100);
      expect(gain).toBeGreaterThanOrEqual(MIN_NORM_GAIN);
      expect(gain).toBeLessThanOrEqual(MAX_NORM_GAIN);
    }
  });

  it('measures a bass-heavy and a bright track as comparably loud', () => {
    // This is the point of K-weighting: equal RMS should not mean equal gain,
    // and a 60 Hz tone should be treated as quieter than a 1 kHz one of the
    // same amplitude, so it receives more gain.
    const bass = measureNormalizeGain(makeSignal('bass60', 44100, 20, 2), 44100);
    const mid = measureNormalizeGain(makeSignal('sine1k', 44100, 20, 2), 44100);
    // bass60 is 0.8 amplitude vs sine1k's 0.5, yet K-weighting discounts it
    // enough that the two land within a few dB of each other.
    const differenceDb = Math.abs(20 * Math.log10(bass / mid));
    expect(differenceDb).toBeLessThan(6);
  });
});
