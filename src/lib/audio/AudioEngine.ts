// Web Audio engine: decodes audio into AudioBuffers up front and plays each hit
// through a fresh AudioBufferSourceNode -> per-cue GainNode -> masterGain, with
// sample-accurate fades. This keeps click-to-sound latency near zero.

import type { AudioCue, PlaybackState, TriggerEvent } from '../types';

type CueEvent = TriggerEvent;

/** How a stop resolves the resume position: 'auto' respects the cue's own
 *  onStopBehavior (plain click/toggle); 'pause'/'stop' force it either way
 *  (explicit trigger actions). */
type StopMode = 'auto' | 'pause' | 'stop';

interface Playback {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Post-gain tap for measuring live output level (audio passes through). */
  analyser: AnalyserNode;
  cue: AudioCue;
  /** ctx.currentTime when playback started. */
  startedAt: number;
  /** Offset into the buffer (seconds) where playback started. */
  offset: number;
  state: PlaybackState;
  /** Timer that flips fadingIn -> playing. */
  fadeInTimer: number | null;
  /** Timer that finalizes after a fade-out. */
  stopTimer: number | null;
  /** A deliberate stop/pause was requested (vs. a natural end). */
  stopping: boolean;
  /** Resolved intent of the deliberate stop, set by stop(); see StopMode. */
  stopMode: StopMode;
  finalized: boolean;
}

const MIN_GAIN = 0.0001;

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
const TARGET_LUFS = -14; // reference integrated loudness (Spotify/YouTube-ish)
const ABS_GATE_LUFS = -70; // BS.1770 absolute gate
const REL_GATE_LU = -10; // relative gate, in LU below the ungated mean
const BLOCK_SEC = 0.4; // gating block length
const HOP_SEC = 0.1; // 75% overlap between blocks
const PEAK_CEIL = 0.99; // leave a sliver of headroom below full scale
const MIN_NORM_GAIN = 0.1;
const MAX_NORM_GAIN = 16;

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

/** Apply a biquad to a channel in place (direct form I). */
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

/** Integrated loudness in LUFS (BS.1770 gated), or -Infinity if immeasurable. */
function integratedLufs(buffer: AudioBuffer): number {
  const fs = buffer.sampleRate;
  const len = buffer.length;
  const block = Math.round(BLOCK_SEC * fs);
  if (len < block) return -Infinity; // too short to gate meaningfully
  const [shelf, hp] = kWeighting(fs);

  // K-weight a copy of each channel (all channels weighted 1.0 — fine for
  // mono/stereo music).
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const y = new Float32Array(buffer.getChannelData(c));
    filterInPlace(y, shelf);
    filterInPlace(y, hp);
    chans.push(y);
  }

  // Mean square per 400 ms block, summed across channels.
  const hop = Math.round(HOP_SEC * fs);
  const z: number[] = [];
  for (let start = 0; start + block <= len; start += hop) {
    let sum = 0;
    for (const d of chans) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += d[i] * d[i];
      sum += s / block;
    }
    z.push(sum);
  }

  const loud = (ms: number) => -0.691 + 10 * Math.log10(ms);
  // Absolute gate, then relative gate at -10 LU below the abs-gated mean.
  let sum = 0,
    n = 0;
  for (const ms of z) if (ms > 0 && loud(ms) >= ABS_GATE_LUFS) (sum += ms), n++;
  if (n === 0) return -Infinity;
  const relThresh = loud(sum / n) + REL_GATE_LU;
  sum = 0;
  n = 0;
  for (const ms of z) {
    if (ms > 0 && loud(ms) >= ABS_GATE_LUFS && loud(ms) >= relThresh) (sum += ms), n++;
  }
  if (n === 0) return -Infinity;
  return loud(sum / n);
}

/**
 * Measure a decoded buffer and return the gain that brings it to the reference
 * loudness (bounded, and peak-limited so it can't clip at volume 1).
 */
function measureNormalizeGain(buffer: AudioBuffer): number {
  const lufs = integratedLufs(buffer);
  if (!isFinite(lufs)) return 1; // too short / silent — leave it alone

  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
    }
  }

  const loudGain = Math.pow(10, (TARGET_LUFS - lufs) / 20);
  const peakGain = peak > MIN_GAIN ? PEAK_CEIL / peak : MAX_NORM_GAIN;
  const gain = Math.min(loudGain, peakGain);
  return Math.min(MAX_NORM_GAIN, Math.max(MIN_NORM_GAIN, gain));
}

export class AudioEngine {
  private ctx: AudioContext;
  private masterGain: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  /** Loudness-normalization gain per file path, measured once and shared by
   *  every cue pointing at that file. Rebuilt on open; not persisted. */
  private fileGains = new Map<string, number>();
  private active = new Map<string, Playback>();
  /** Saved resume position for cues whose onStopBehavior is "pause". */
  private paused = new Map<string, number>();
  /** Reused scratch buffer for level measurement. */
  private levelBuf = new Float32Array(256);

  onStateChange: ((id: string, state: PlaybackState) => void) | null = null;
  onCueEvent: ((id: string, event: CueEvent) => void) | null = null;

  constructor() {
    // A hint of latency headroom; 'interactive' minimises output latency.
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);
  }

  /** Must be called from a user gesture; browsers start the context suspended. */
  resumeContext(): Promise<void> {
    if (this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  }

  setMasterVolume(v: number): void {
    this.masterGain.gain.setValueAtTime(Math.max(0, v), this.ctx.currentTime);
  }

  /**
   * Decode `bytes` for a cue, keyed by cue id. `file` is the source path: the
   * first time a given file is seen we measure its loudness-normalization gain
   * and cache it by path, so every cue (and copy) using that file matches.
   */
  async decode(id: string, file: string, bytes: ArrayBuffer): Promise<void> {
    const buffer = await this.ctx.decodeAudioData(bytes);
    this.buffers.set(id, buffer);
    if (file && !this.fileGains.has(file)) {
      this.fileGains.set(file, measureNormalizeGain(buffer));
    }
  }

  hasBuffer(id: string): boolean {
    return this.buffers.has(id);
  }

  /** Effective linear gain for a cue: user trim scaled by its file's
   *  loudness-normalization gain (1 if the file hasn't been measured). */
  private effectiveGain(cue: AudioCue): number {
    return Math.max(0, cue.volume * (this.fileGains.get(cue.file) ?? 1));
  }

  getState(id: string): PlaybackState {
    return this.active.get(id)?.state ?? 'idle';
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Effective clip length in seconds (respects start/end trim). */
  getDuration(cue: AudioCue): number {
    const buffer = this.buffers.get(cue.id);
    if (!buffer) return 0;
    const end = cue.endTime ?? buffer.duration;
    return Math.max(0, end - cue.startTime);
  }

  /** Current playback position within the file (seconds). */
  getPosition(cue: AudioCue): number {
    const pb = this.active.get(cue.id);
    const buffer = this.buffers.get(cue.id);
    if (!buffer) return cue.startTime;
    const end = cue.endTime ?? buffer.duration;
    if (!pb) return this.paused.get(cue.id) ?? cue.startTime;
    let pos = pb.offset + (this.ctx.currentTime - pb.startedAt);
    if (cue.loop) {
      const span = end - cue.startTime;
      if (span > 0) pos = cue.startTime + ((pos - cue.startTime) % span);
    }
    return Math.min(pos, end);
  }

  /** Live output loudness of a playing cue (RMS, 0..1). 0 if not playing. */
  getLevel(id: string): number {
    const pb = this.active.get(id);
    if (!pb) return 0;
    pb.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const s = this.levelBuf[i];
      sum += s * s;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length));
  }

  private setState(pb: Playback, state: PlaybackState): void {
    pb.state = state;
    this.onStateChange?.(pb.cue.id, state);
  }

  /** Start (or restart) a cue. `fade` false => instant full volume (trigger use).
   *  `fresh` true => ignore any saved paused position, always start at cue.startTime
   *  (used by the explicit "Start" trigger action; click/toggle and resume() keep
   *  `fresh = false`, i.e. auto-resume if there's a saved position). */
  start(cue: AudioCue, fade = true, fresh = false): void {
    const buffer = this.buffers.get(cue.id);
    if (!buffer) return;
    void this.resumeContext();

    // Restart cleanly if already playing.
    if (this.active.has(cue.id)) this.hardStop(cue.id);

    const now = this.ctx.currentTime;
    const end = cue.endTime ?? buffer.duration;

    let offset = fresh ? cue.startTime : (this.paused.get(cue.id) ?? cue.startTime);
    if (offset < cue.startTime || offset >= end) offset = cue.startTime;
    this.paused.delete(cue.id);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    // source -> gain -> analyser -> master. The analyser is a pass-through, so
    // it measures the post-fade output level without altering the audio.
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(this.masterGain);

    if (cue.loop) {
      source.loop = true;
      source.loopStart = cue.startTime;
      source.loopEnd = end;
    }

    const target = this.effectiveGain(cue);
    const fadeInSec = fade ? cue.fadeIn : 0;
    if (fadeInSec > 0) {
      gain.gain.setValueAtTime(MIN_GAIN, now);
      gain.gain.linearRampToValueAtTime(Math.max(target, MIN_GAIN), now + fadeInSec);
    } else {
      gain.gain.setValueAtTime(target, now);
    }

    if (cue.loop) {
      source.start(now, offset);
    } else {
      source.start(now, offset, Math.max(0, end - offset));
    }

    const pb: Playback = {
      source,
      gain,
      analyser,
      cue,
      startedAt: now,
      offset,
      state: fadeInSec > 0 ? 'fadingIn' : 'playing',
      fadeInTimer: null,
      stopTimer: null,
      stopping: false,
      stopMode: 'auto',
      finalized: false,
    };
    this.active.set(cue.id, pb);

    source.onended = () => {
      // Fires on natural end (non-loop) and after an explicit stop(). Only the
      // natural-end case still needs finalizing (reset position, fire onStop).
      if (!pb.finalized) this.finalize(pb, 'natural');
    };

    if (fadeInSec > 0) {
      pb.fadeInTimer = window.setTimeout(() => {
        if (this.active.get(cue.id) === pb && pb.state === 'fadingIn') {
          this.setState(pb, 'playing');
        }
      }, cue.fadeIn * 1000);
    }

    this.onStateChange?.(cue.id, pb.state);
    this.onCueEvent?.(cue.id, 'onStart');
  }

  /** Stop a cue. `fade` false => instant stop (trigger use).
   *  `mode`: 'auto' (click/toggle) respects the cue's own onStopBehavior; 'pause'/
   *  'stop' force the resume-position handling either way (explicit trigger actions). */
  stop(cue: AudioCue, fade = true, mode: StopMode = 'auto'): void {
    const pb = this.active.get(cue.id);
    if (!pb || pb.finalized) return;
    const firstStop = !pb.stopping;
    pb.stopping = true;
    pb.stopMode = mode;
    const now = this.ctx.currentTime;
    const fadeOutSec = fade ? cue.fadeOut : 0;

    if (fadeOutSec > 0) {
      const current = Math.max(pb.gain.gain.value, MIN_GAIN);
      pb.gain.gain.cancelScheduledValues(now);
      pb.gain.gain.setValueAtTime(current, now);
      pb.gain.gain.linearRampToValueAtTime(MIN_GAIN, now + fadeOutSec);
      try {
        pb.source.stop(now + fadeOutSec);
      } catch {
        /* already stopped */
      }
      this.setState(pb, 'fadingOut');
      pb.stopTimer = window.setTimeout(() => this.finalize(pb, 'stopped'), cue.fadeOut * 1000);
    } else {
      try {
        pb.source.stop(now);
      } catch {
        /* already stopped */
      }
      this.finalize(pb, 'stopped');
    }

    // Fire the moment a stop/pause is requested (not after the fade), once per
    // stop. State/teardown are already set above so re-entrancy is safe.
    if (firstStop) {
      const willPause = mode === 'pause' || (mode === 'auto' && cue.onStopBehavior === 'pause');
      this.onCueEvent?.(cue.id, willPause ? 'onPause' : 'onStop');
    }
  }

  /** Explicit pause: always saves the resume position, regardless of onStopBehavior. */
  pause(cue: AudioCue, fade = true): void {
    this.stop(cue, fade, 'pause');
  }

  /** Continue from a saved paused position. No-op if nothing is paused. */
  resume(cue: AudioCue, fade = true): void {
    if (!this.paused.has(cue.id)) return;
    this.start(cue, fade, false);
  }

  toggle(cue: AudioCue): void {
    const state = this.getState(cue.id);
    if (state === 'idle') this.start(cue);
    else this.stop(cue);
  }

  /** Immediate teardown without firing onStop (used when restarting). */
  private hardStop(id: string): void {
    const pb = this.active.get(id);
    if (!pb) return;
    pb.finalized = true;
    if (pb.fadeInTimer !== null) clearTimeout(pb.fadeInTimer);
    if (pb.stopTimer !== null) clearTimeout(pb.stopTimer);
    try {
      pb.source.stop();
    } catch {
      /* noop */
    }
    pb.source.disconnect();
    pb.gain.disconnect();
    pb.analyser.disconnect();
    this.active.delete(id);
  }

  private finalize(pb: Playback, reason: 'stopped' | 'natural'): void {
    if (pb.finalized) return;
    pb.finalized = true;
    if (pb.fadeInTimer !== null) clearTimeout(pb.fadeInTimer);
    if (pb.stopTimer !== null) clearTimeout(pb.stopTimer);

    const id = pb.cue.id;

    // Save resume position when this was a deliberate pause (explicit, or 'auto'
    // deferring to the cue's own onStopBehavior), regardless of whether the fade
    // timer or the source's onended reached finalize first.
    const willPause = pb.stopMode === 'pause' || (pb.stopMode === 'auto' && pb.cue.onStopBehavior === 'pause');
    if (pb.stopping && willPause) {
      this.paused.set(id, this.getPosition(pb.cue));
    } else {
      this.paused.delete(id);
    }

    try {
      pb.source.stop();
    } catch {
      /* noop */
    }
    pb.source.disconnect();
    pb.gain.disconnect();
    pb.analyser.disconnect();
    this.active.delete(id);

    this.setState(pb, 'idle');
    // A deliberate stop/pause already fired its event in stop(); only fire here
    // for a natural end (the cue reaching its out point on its own).
    if (reason === 'natural') this.onCueEvent?.(id, 'onEnd');
  }

  /** Stop everything and drop all decoded buffers (used on project reload). */
  clear(): void {
    for (const id of [...this.active.keys()]) this.hardStop(id);
    this.buffers.clear();
    this.fileGains.clear();
    this.paused.clear();
  }
}
