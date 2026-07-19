// Loudness normalization, ITU-R BS.1770 / EBU R128 style — the same approach
// streaming platforms use. We measure a track's INTEGRATED loudness (LUFS) once
// and apply a single static gain to reach a reference level, which preserves the
// track's own dynamics (unlike compression, we never ride the gain within a
// song). Two refinements over plain RMS matter for music:
//   * K-weighting: a perceptual frequency filter, so a bass-heavy track and a
//     bright one that measure equal actually sound equally loud.
//   * Gating: loudness is measured in 400 ms blocks and near-silent blocks are
//     dropped, so a quiet intro/breakdown doesn't drag the average down.
// A sample-peak guard then caps the gain so playback can't clip at volume = 1.
//
// This module is pure number-crunching over raw channel data, with no Web Audio
// or DOM dependencies, so it can run either on the main thread or inside
// loudness.worker.ts. See loudnessPool.ts for the worker pool that drives it.

const TARGET_LUFS = -14; // reference integrated loudness (Spotify/YouTube-ish)
const ABS_GATE_LUFS = -70; // BS.1770 absolute gate
const REL_GATE_LU = -10; // relative gate, in LU below the ungated mean
const HOP_SEC = 0.1; // gating hop; blocks are 4 hops (400 ms, 75% overlap)
const PEAK_CEIL = 0.99; // leave a sliver of headroom below full scale
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

/** The two BS.1770 K-weighting stages, redesigned for the given sample rate. */
function kWeighting(fs: number): [Biquad, Biquad] {
  // Stage 1: high shelf (~ +4 dB above ~1.5 kHz).
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
  // Stage 2: RLB high-pass (~38 Hz).
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

/**
 * Apply both K-weighting stages to a channel in place in a single pass, then
 * accumulate the sum of squares per hop into `hopSums`.
 *
 * Cascading the two biquads inside one loop (rather than filtering twice) keeps
 * the channel in cache for a single traversal, and folding the squaring into the
 * same pass avoids yet another one. `hopSums` is the key optimisation: BS.1770
 * blocks overlap by 75%, so summing each 400 ms block directly would touch every
 * sample four times. Summing disjoint 100 ms hops once and adding four adjacent
 * hop sums per block gives the identical result for a quarter of the work.
 */
function weightAndAccumulate(
  x: Float32Array,
  shelf: Biquad,
  hp: Biquad,
  hop: number,
  hopSums: Float64Array,
): void {
  // Stage 1 state.
  let u1 = 0,
    u2 = 0,
    v1 = 0,
    v2 = 0;
  // Stage 2 state.
  let w1 = 0,
    w2 = 0,
    y1 = 0,
    y2 = 0;
  const n = x.length;
  const hops = hopSums.length;
  for (let h = 0; h < hops; h++) {
    const end = Math.min((h + 1) * hop, n);
    let acc = 0;
    for (let i = h * hop; i < end; i++) {
      const u0 = x[i];
      const v0 = shelf.b0 * u0 + shelf.b1 * u1 + shelf.b2 * u2 - shelf.a1 * v1 - shelf.a2 * v2;
      u2 = u1;
      u1 = u0;
      v2 = v1;
      v1 = v0;

      const y0 = hp.b0 * v0 + hp.b1 * w1 + hp.b2 * w2 - hp.a1 * y1 - hp.a2 * y2;
      w2 = w1;
      w1 = v0;
      y2 = y1;
      y1 = y0;

      acc += y0 * y0;
    }
    hopSums[h] += acc;
  }
}

const loudnessOf = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/**
 * Correction for the channel up-mix the browser will apply at playback time.
 *
 * BS.1770 sums mean-square across the channels it is handed, so the *same*
 * recording stored as 1-channel mono measures 3.01 dB quieter than the same
 * content stored as dual-mono stereo — there is simply one channel of energy
 * instead of two. Measuring the stored file directly would therefore hand the
 * mono copy ~3 dB more gain.
 *
 * But the two do not play back differently. Web Audio's default "speakers"
 * up-mix sends a mono source to both outputs at full amplitude (L = R = input),
 * so a mono file and its dual-mono stereo twin hit the speakers identically. We
 * want the two to end up at the same level, so mono is measured as the pair of
 * channels it will actually become: two copies of one channel is twice the
 * mean-square, i.e. the +3.01 dB that closes the gap exactly.
 *
 * Multi-channel sources are left alone — down-mixing them properly is a
 * different problem, and stereo (the overwhelmingly common case) needs nothing.
 */
function upmixWeight(channelCount: number): number {
  return channelCount === 1 ? 2 : 1;
}

/**
 * Integrated loudness in LUFS (BS.1770 gated), or -Infinity if immeasurable.
 *
 * Measured as the signal will actually be *rendered*, not as it is stored — see
 * `upmixWeight`.
 */
function integratedLufs(channels: Float32Array[], fs: number): number {
  const len = channels[0]?.length ?? 0;
  const hop = Math.round(HOP_SEC * fs);
  const block = hop * 4;
  if (len < block) return -Infinity; // too short to gate meaningfully

  const [shelf, hp] = kWeighting(fs);
  const hops = Math.ceil(len / hop);
  // Sum of squares per hop, summed across channels (all weighted 1.0 — fine for
  // mono/stereo music).
  const hopSums = new Float64Array(hops);
  for (const chan of channels) weightAndAccumulate(chan, shelf, hp, hop, hopSums);

  const weight = upmixWeight(channels.length);
  if (weight !== 1) {
    for (let i = 0; i < hopSums.length; i++) hopSums[i] *= weight;
  }

  // Mean square per 400 ms block = four adjacent hops, advanced one hop at a
  // time (75% overlap).
  const blocks = hops - 3;
  const z = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    z[b] = (hopSums[b] + hopSums[b + 1] + hopSums[b + 2] + hopSums[b + 3]) / block;
  }

  // Absolute gate, then relative gate at -10 LU below the abs-gated mean.
  let sum = 0,
    n = 0;
  for (const ms of z) if (ms > 0 && loudnessOf(ms) >= ABS_GATE_LUFS) (sum += ms), n++;
  if (n === 0) return -Infinity;
  const relThresh = loudnessOf(sum / n) + REL_GATE_LU;
  sum = 0;
  n = 0;
  for (const ms of z) {
    if (ms > 0 && loudnessOf(ms) >= ABS_GATE_LUFS && loudnessOf(ms) >= relThresh) (sum += ms), n++;
  }
  if (n === 0) return -Infinity;
  return loudnessOf(sum / n);
}

/**
 * Measure raw channel data and return the gain that brings it to the reference
 * loudness (bounded, and peak-limited so it can't clip at volume 1).
 *
 * NOTE: this filters `channels` IN PLACE — pass copies, never an AudioBuffer's
 * own `getChannelData()` views.
 */
export function measureNormalizeGain(channels: Float32Array[], sampleRate: number): number {
  if (channels.length === 0) return 1;

  // Sample peak must be read from the unfiltered signal, before K-weighting
  // overwrites it in place.
  let peak = 0;
  for (const d of channels) {
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
    }
  }

  const lufs = integratedLufs(channels, sampleRate);
  if (!isFinite(lufs)) return 1; // too short / silent — leave it alone

  const loudGain = Math.pow(10, (TARGET_LUFS - lufs) / 20);
  const peakGain = peak > MIN_LEVEL ? PEAK_CEIL / peak : MAX_NORM_GAIN;
  const gain = Math.min(loudGain, peakGain);
  return Math.min(MAX_NORM_GAIN, Math.max(MIN_NORM_GAIN, gain));
}

export interface LoudnessRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
}

export interface LoudnessResponse {
  id: number;
  gain: number;
}
