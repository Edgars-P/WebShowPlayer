// Web Audio engine: decodes audio into AudioBuffers up front and plays each hit
// through a fresh AudioBufferSourceNode -> per-cue GainNode -> masterGain, with
// sample-accurate fades. This keeps click-to-sound latency near zero.

import type { AudioCue, PlaybackState } from '../types';

type CueEvent = 'onStart' | 'onStop';

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
  finalized: boolean;
}

const MIN_GAIN = 0.0001;

export class AudioEngine {
  private ctx: AudioContext;
  private masterGain: GainNode;
  private buffers = new Map<string, AudioBuffer>();
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
  resume(): Promise<void> {
    if (this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  }

  setMasterVolume(v: number): void {
    this.masterGain.gain.setValueAtTime(Math.max(0, v), this.ctx.currentTime);
  }

  async decode(id: string, bytes: ArrayBuffer): Promise<void> {
    const buffer = await this.ctx.decodeAudioData(bytes);
    this.buffers.set(id, buffer);
  }

  hasBuffer(id: string): boolean {
    return this.buffers.has(id);
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

  /** Start (or restart) a cue. `fade` false => instant full volume (trigger use). */
  start(cue: AudioCue, fade = true): void {
    const buffer = this.buffers.get(cue.id);
    if (!buffer) return;
    void this.resume();

    // Restart cleanly if already playing.
    if (this.active.has(cue.id)) this.hardStop(cue.id);

    const now = this.ctx.currentTime;
    const end = cue.endTime ?? buffer.duration;

    let offset = this.paused.get(cue.id) ?? cue.startTime;
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

    const fadeInSec = fade ? cue.fadeIn : 0;
    if (fadeInSec > 0) {
      gain.gain.setValueAtTime(MIN_GAIN, now);
      gain.gain.linearRampToValueAtTime(Math.max(cue.volume, MIN_GAIN), now + fadeInSec);
    } else {
      gain.gain.setValueAtTime(cue.volume, now);
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

  /** Stop a cue. `fade` false => instant stop (trigger use). */
  stop(cue: AudioCue, fade = true): void {
    const pb = this.active.get(cue.id);
    if (!pb || pb.finalized) return;
    const firstStop = !pb.stopping;
    pb.stopping = true;
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

    // Fire onStop the moment a stop/pause is requested (not after the fade),
    // once per stop. State/teardown are already set above so re-entrancy is safe.
    if (firstStop) this.onCueEvent?.(cue.id, 'onStop');
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

    // Save resume position when this was a deliberate pause-stop, regardless of
    // whether the fade timer or the source's onended reached finalize first.
    if (pb.stopping && pb.cue.onStopBehavior === 'pause') {
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
    // A deliberate stop already fired onStop in stop(); only fire here for a
    // natural end (the cue reaching its out point on its own).
    if (reason === 'natural') this.onCueEvent?.(id, 'onStop');
  }

  /** Stop everything and drop all decoded buffers (used on project reload). */
  clear(): void {
    for (const id of [...this.active.keys()]) this.hardStop(id);
    this.buffers.clear();
    this.paused.clear();
  }
}
