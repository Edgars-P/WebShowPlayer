// Web Audio engine: holds decoded AudioBuffers up front and plays each hit
// through a fresh AudioBufferSourceNode -> per-cue GainNode -> the document's
// masterGain, with sample-accurate fades. This keeps click-to-sound latency near
// zero.
//
// One engine per open document. The AudioContext and the decoded buffers
// themselves are shared process-wide (see sharedAudio.ts); this class owns only
// the document's master gain node and its cue -> file bindings.

import type { AudioCue, PlaybackState, TriggerEvent } from '../types';
import { audioCache, cacheKey, getAudioContext, resumeAudioContext } from './sharedAudio';

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
  /** ctx.currentTime at which this playback reaches its out point (0 = loops). */
  endsAt: number;
  /** Window of the fade currently in progress, for the readout. Equal when
   *  nothing is fading. */
  fadeFrom: number;
  fadeUntil: number;
  state: PlaybackState;
  /** Timer that flips fadingIn -> playing. */
  fadeInTimer: number | null;
  /** Timer that flips playing -> fadingOut for a scheduled end-of-clip fade. */
  endFadeTimer: number | null;
  /** Timer that finalizes after a fade-out. */
  stopTimer: number | null;
  /** A deliberate stop/pause was requested (vs. a natural end). */
  stopping: boolean;
  /** Resolved intent of the deliberate stop, set by stop(); see StopMode. */
  stopMode: StopMode;
  finalized: boolean;
}

const MIN_GAIN = 0.0001;

export class AudioEngine {
  private ctx: AudioContext;
  private masterGain: GainNode;
  /** Cue id -> shared-cache key, i.e. which file each cue is bound to. */
  private bindings = new Map<string, string>();
  private active = new Map<string, Playback>();
  /** Saved resume position for cues whose onStopBehavior is "pause". */
  private paused = new Map<string, number>();
  /** Reused scratch buffer for level measurement. */
  private levelBuf = new Float32Array(256);

  onStateChange: ((id: string, state: PlaybackState) => void) | null = null;
  onCueEvent: ((id: string, event: CueEvent) => void) | null = null;

  constructor() {
    this.ctx = getAudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);
  }

  resumeContext(): Promise<void> {
    return resumeAudioContext();
  }

  setMasterVolume(v: number): void {
    this.masterGain.gain.setValueAtTime(Math.max(0, v), this.ctx.currentTime);
  }

  /**
   * Bind a cue to a file in the shared cache, decoding it if no other cue (in
   * any document) already holds it. `folderId` scopes the path so two folders
   * with a same-named file don't collide.
   */
  async load(id: string, folderId: string, path: string, load: () => Promise<ArrayBuffer>): Promise<void> {
    const key = cacheKey(folderId, path);
    const previous = this.bindings.get(id);
    if (previous === key) return; // already bound to this exact file
    this.bindings.set(id, key);
    try {
      await audioCache.acquire(key, load);
      // A later load() (or unload) may have re-pointed this cue while we waited.
      if (this.bindings.get(id) !== key) {
        audioCache.release(key);
        return;
      }
      if (previous) audioCache.release(previous);
    } catch (err) {
      if (this.bindings.get(id) === key) this.bindings.delete(id);
      if (previous) audioCache.release(previous);
      throw err;
    }
  }

  /** Drop a cue's claim on its file (when the cue is deleted). */
  unload(id: string): void {
    const key = this.bindings.get(id);
    if (!key) return;
    this.bindings.delete(id);
    audioCache.release(key);
  }

  private cached(id: string) {
    const key = this.bindings.get(id);
    return key ? audioCache.get(key) : null;
  }

  private bufferFor(id: string): AudioBuffer | null {
    return this.cached(id)?.buffer ?? null;
  }

  // NOTE: whether a cue's media is loaded is deliberately not exposed here.
  // Buffers live in a plain Map in the shared cache, so any answer this could
  // give would be unobservable to the UI; Doc.audioStatus tracks readiness in
  // reactive state instead, and is what tiles and the inspector read.

  /** Effective linear gain for a cue: user trim scaled by its file's
   *  loudness-normalization gain (1 if the file hasn't been measured). */
  private effectiveGain(cue: AudioCue): number {
    return Math.max(0, cue.volume * (this.cached(cue.id)?.gain ?? 1));
  }

  getState(id: string): PlaybackState {
    return this.active.get(id)?.state ?? 'idle';
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Effective clip length in seconds (respects start/end trim). */
  getDuration(cue: AudioCue): number {
    const buffer = this.bufferFor(cue.id);
    if (!buffer) return 0;
    const end = cue.endTime ?? buffer.duration;
    return Math.max(0, end - cue.startTime);
  }

  /** Current playback position within the file (seconds). */
  getPosition(cue: AudioCue): number {
    const pb = this.active.get(cue.id);
    const buffer = this.bufferFor(cue.id);
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

  /**
   * How far through the fade currently in progress, 0..1 — 1 when the cue
   * isn't fading. Read off the audio clock, so it matches what's audible
   * rather than counting frames.
   */
  getFadeProgress(id: string): number {
    const pb = this.active.get(id);
    if (!pb || pb.fadeUntil <= pb.fadeFrom) return 1;
    const span = pb.fadeUntil - pb.fadeFrom;
    return Math.min(1, Math.max(0, (this.ctx.currentTime - pb.fadeFrom) / span));
  }

  /**
   * How long the fade in progress was asked to take, in seconds; 0 when the cue
   * isn't fading. What's on the cue is only the request — an end-of-clip fade is
   * cut to the audio that's left — so a readout that has to know how much time a
   * fade has in it has to ask the playback, not the cue.
   */
  getFadeSeconds(id: string): number {
    const pb = this.active.get(id);
    if (!pb || pb.fadeUntil <= pb.fadeFrom) return 0;
    return pb.fadeUntil - pb.fadeFrom;
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
    const buffer = this.bufferFor(cue.id);
    if (!buffer) return;
    void this.resumeContext();

    // Restart cleanly if already playing.
    if (this.active.has(cue.id)) this.hardStop(cue.id);

    const now = this.ctx.currentTime;
    // Clamp to the buffer: an endTime past the file's length would otherwise
    // put the scheduled end-of-clip fade after the audio has already run out.
    const end = Math.min(cue.endTime ?? buffer.duration, buffer.duration);

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

    const playDur = Math.max(0, end - offset);

    if (cue.loop) {
      source.start(now, offset);
    } else {
      source.start(now, offset, playDur);
    }

    const pb: Playback = {
      source,
      gain,
      analyser,
      cue,
      startedAt: now,
      offset,
      // ctx time this playback reaches its out point; 0 while looping, which
      // never does.
      endsAt: cue.loop ? 0 : now + playDur,
      fadeFrom: now,
      fadeUntil: now + fadeInSec,
      state: fadeInSec > 0 ? 'fadingIn' : 'playing',
      fadeInTimer: null,
      endFadeTimer: null,
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
      const landsAt = now + fadeInSec;
      this.atAudioTime(
        landsAt,
        (id) => (pb.fadeInTimer = id),
        () => {
          if (this.active.get(cue.id) === pb && pb.state === 'fadingIn') {
            this.setState(pb, 'playing');
          }
        },
      );
    }

    // Fade onto the out point, if asked for — never starting before the
    // fade-in has finished.
    this.scheduleEndFade(pb, now + fadeInSec);

    this.onStateChange?.(cue.id, pb.state);
    this.onCueEvent?.(cue.id, 'onStart');
  }

  /**
   * Run `fn` once the audio clock reaches `at`, keeping the pending timer's id
   * wherever `hold` puts it so it can still be cancelled.
   *
   * Everything a fade does is scheduled on the audio clock, but a timeout runs
   * on the wall clock, and on the first cue of a session those are not the same
   * clock: the context is suspended until a gesture, and `resumeContext()` is
   * deliberately not awaited, so the ramps go down against a `currentTime` that
   * hasn't started moving yet. The wall clock has. A plain timeout for the
   * fade's length then fires while the audible ramp still has that head start
   * left to run — which showed up on the grid as a tile committing to full while
   * its wedge was still a second from the end, on the first play and no other.
   *
   * So a timeout that lands early is re-armed for the difference rather than
   * trusted, and the wait is measured off the audio clock each time round.
   */
  private atAudioTime(at: number, hold: (id: number) => void, fn: () => void): void {
    const arm = () => {
      const left = at - this.ctx.currentTime;
      hold(
        window.setTimeout(
          () => {
            // Behind still: the clock wasn't running for some of that wait.
            if (this.ctx.currentTime < at) arm();
            else fn();
          },
          Math.max(0, left * 1000),
        ),
      );
    };
    arm();
  }

  /**
   * Schedule the fade that lands on this playback's out point, if the cue asks
   * for one. `from` is the earliest ctx time the fade may begin.
   *
   * Separate from start() because cancelling automation (finishing a fade-in
   * early) wipes this ramp too, and it then has to be laid down again over
   * whatever time is left.
   */
  private scheduleEndFade(pb: Playback, from: number): void {
    const cue = pb.cue;
    if (!cue.fadeOutOnEnd || cue.loop || cue.fadeOut <= 0 || pb.endsAt <= 0) return;

    // Never longer than the audio that's left — resuming a few seconds from the
    // end should fade over those seconds, not get cut off mid-ramp.
    const fadeDur = Math.min(cue.fadeOut, pb.endsAt - from);
    const start = Math.max(from, pb.endsAt - fadeDur);
    if (start >= pb.endsAt) return;

    pb.gain.gain.setValueAtTime(this.effectiveGain(cue), start);
    pb.gain.gain.linearRampToValueAtTime(MIN_GAIN, pb.endsAt);

    // The ramp above is on the audio clock; this only moves the tile into its
    // fading-out look at the same moment.
    if (pb.endFadeTimer !== null) clearTimeout(pb.endFadeTimer);
    this.atAudioTime(
      start,
      (id) => (pb.endFadeTimer = id),
      () => {
        if (this.active.get(cue.id) !== pb || pb.stopping) return;
        // Only now does this become the fade in progress — setting it at
        // schedule time would clobber a fade-in that's still running.
        pb.fadeFrom = start;
        pb.fadeUntil = pb.endsAt;
        this.setState(pb, 'fadingOut');
      },
    );
  }

  /**
   * Move a cue to a new position in its file (absolute seconds), without
   * disturbing anything else about it.
   *
   * A running cue gets a fresh source node spliced onto its existing gain node,
   * so whatever the fade automation is doing carries straight through the jump —
   * scrubbing a cue that's easing in doesn't cut it to full and doesn't restart
   * the fade. Nothing here fires an event: seeking is not starting or stopping,
   * and a chain hanging off this cue must not go off because someone dragged a
   * scrub bar.
   *
   * An idle or paused cue has no source to move, so the position is stored as
   * its resume point instead — lining a cue up before firing it.
   */
  seek(cue: AudioCue, position: number): void {
    const buffer = this.bufferFor(cue.id);
    if (!buffer) return;
    const end = Math.min(cue.endTime ?? buffer.duration, buffer.duration);
    // Never land exactly on the out point: a zero-length playback would end the
    // cue the instant it started, which is not what dragging to the far right
    // of the bar asks for.
    const pos = Math.min(Math.max(position, cue.startTime), Math.max(cue.startTime, end - 0.05));

    const pb = this.active.get(cue.id);
    if (!pb) {
      this.paused.set(cue.id, pos);
      return;
    }
    // On its way out already — the fade is landing on silence, and moving the
    // audio under it would only make a mess of the last half-second.
    if (pb.stopping || pb.finalized) return;

    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(pb.gain);
    if (cue.loop) {
      source.loop = true;
      source.loopStart = cue.startTime;
      source.loopEnd = end;
    }

    // Retire the old source silently: its `onended` fires as we stop it, and
    // left alone it would finalize the cue as if the clip had played out.
    const old = pb.source;
    old.onended = null;
    try {
      old.stop();
    } catch {
      /* already stopped */
    }
    old.disconnect();

    const playDur = Math.max(0, end - pos);
    if (cue.loop) source.start(now, pos);
    else source.start(now, pos, playDur);

    pb.source = source;
    pb.startedAt = now;
    pb.offset = pos;
    pb.endsAt = cue.loop ? 0 : now + playDur;
    source.onended = () => {
      if (!pb.finalized) this.finalize(pb, 'natural');
    };

    if (pb.state === 'fadingIn') {
      // The fade-in ramp is already on the gain node and still correct; only the
      // end-of-clip fade needs re-aiming, and it may not start before that ramp.
      this.scheduleEndFade(pb, Math.max(now, pb.fadeUntil));
    } else {
      // Any end-of-clip fade was aimed at the old out point — including one
      // already running, if the jump was backwards out of it. Wipe it, restore
      // full level, and lay a fresh one down against the new out point.
      pb.gain.gain.cancelScheduledValues(now);
      pb.gain.gain.setValueAtTime(this.effectiveGain(cue), now);
      if (pb.state !== 'playing') {
        pb.fadeFrom = pb.fadeUntil = 0;
        this.setState(pb, 'playing');
      }
      this.scheduleEndFade(pb, now);
    }
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
    pb.fadeFrom = now;
    pb.fadeUntil = now + fadeOutSec;

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
      this.atAudioTime(
        pb.fadeUntil,
        (id) => (pb.stopTimer = id),
        () => this.finalize(pb, 'stopped'),
      );
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

  /**
   * What a plain click does. Mid-fade, a second click completes the fade
   * immediately rather than reversing it — press again to snap a cue that's
   * easing in up to full level, or to cut short one that's on its way out.
   */
  toggle(cue: AudioCue): void {
    const pb = this.active.get(cue.id);
    const state = pb?.state ?? 'idle';
    if (state === 'idle') this.start(cue);
    else if (state === 'fadingIn') this.finishFadeIn(pb!);
    else if (state === 'fadingOut') this.finishFadeOut(pb!);
    else this.stop(cue);
  }

  /** Jump a fading-in cue straight to its full level and keep it playing. */
  private finishFadeIn(pb: Playback): void {
    const now = this.ctx.currentTime;
    pb.gain.gain.cancelScheduledValues(now);
    pb.gain.gain.setValueAtTime(this.effectiveGain(pb.cue), now);
    if (pb.fadeInTimer !== null) {
      clearTimeout(pb.fadeInTimer);
      pb.fadeInTimer = null;
    }
    pb.fadeFrom = pb.fadeUntil = 0; // the fade is over, not merely interrupted
    this.setState(pb, 'playing');
    // cancelScheduledValues wiped any end-of-clip fade; lay it down again over
    // the time that's left.
    this.scheduleEndFade(pb, now);
  }

  /** Cut a fading-out cue to silence now, finishing what the fade started. */
  private finishFadeOut(pb: Playback): void {
    // A deliberate stop already announced itself (stop() fires onStop/onPause
    // the moment it's requested), so this only has to finalize. A cue drifting
    // out on its own scheduled end-fade hasn't announced anything yet, so route
    // it through a normal instant stop to fire the right event and honour the
    // cue's own stop-vs-pause behaviour.
    if (pb.stopping) this.finalize(pb, 'stopped');
    else this.stop(pb.cue, false, 'auto');
  }

  /** Immediate teardown without firing onStop (used when restarting). */
  private hardStop(id: string): void {
    const pb = this.active.get(id);
    if (!pb) return;
    pb.finalized = true;
    if (pb.fadeInTimer !== null) clearTimeout(pb.fadeInTimer);
    if (pb.endFadeTimer !== null) clearTimeout(pb.endFadeTimer);
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
    if (pb.endFadeTimer !== null) clearTimeout(pb.endFadeTimer);
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

  /** Stop everything and drop this engine's claims on every buffer it holds.
   *  Buffers still referenced by another document stay decoded. */
  clear(): void {
    for (const id of [...this.active.keys()]) this.hardStop(id);
    for (const key of this.bindings.values()) audioCache.release(key);
    this.bindings.clear();
    this.paused.clear();
  }

  /** Tear down for good (document closed). */
  dispose(): void {
    this.clear();
    this.masterGain.disconnect();
  }
}
