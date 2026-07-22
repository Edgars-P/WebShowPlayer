// Data model for the launchpad player. Cues are a discriminated union on `type`.

export type CueType = 'audio' | 'proxy' | 'http' | 'timer' | 'video' | 'global';

/** Durable address of another cue, by id — survives the cue being moved. */
export interface CueRef {
  cueId: string;
}

export type TriggerEvent = 'onStart' | 'onPause' | 'onStop' | 'onEnd';
export type TriggerAction = 'click' | 'start' | 'pause' | 'resume' | 'stop' | 'set' | 'clear';

export interface Trigger {
  /**
   * Which of the source cue's lifecycle events fire this trigger. More than
   * one may be set — e.g. the same action can run on both "stop" and the cue
   * ending on its own — since both still mean "this cue is done." Always at
   * least one; a trigger with none would do nothing and isn't kept around.
   */
  events: TriggerEvent[];
  target: CueRef;
  action: TriggerAction;
  /** Use the target's configured fade for start/pause/resume/stop. Ignored for
   *  click/set/clear. Absent (legacy saves) reads as false, matching the previous
   *  always-instant trigger behavior. */
  fade?: boolean;
}

interface BaseCue {
  id: string;
  type: CueType;
  row: number;
  col: number;
  triggers: Trigger[];
}

export type StopBehavior = 'stop' | 'pause';

export interface AudioCue extends BaseCue {
  type: 'audio';
  name: string;
  color: string;
  /** Filename relative to the project folder. */
  file: string;
  /** Seconds into the file to start from. */
  startTime: number;
  /** Seconds into the file to stop at, or null for end-of-file. */
  endTime: number | null;
  /** Fade-in duration in seconds. */
  fadeIn: number;
  /** Fade-out duration in seconds. */
  fadeOut: number;
  /**
   * Also fade out when the cue reaches its own out point (end of file, or
   * `endTime`), not just when something stops it. The fade lands exactly on the
   * out point, so the clip still ends when it always did — it just doesn't cut.
   * Ignored while looping, which never reaches an end. Absent (older saves)
   * reads as false, preserving the previous hard-cut behaviour.
   */
  fadeOutOnEnd?: boolean;
  /**
   * User trim, 0..2. Defaults to 1 (100%), which is the loudness-matched
   * level; raise toward 2 (200%) to boost or lower toward 0 to attenuate.
   * Effective gain = volume * the file's normalization gain (measured per
   * file by the engine, not stored on the cue).
   */
  volume: number;
  loop: boolean;
  /** On stop: reset to startTime ("stop") or keep position to resume ("pause"). */
  onStopBehavior: StopBehavior;
}

/** A live mirror of another cue; controls the same media instance. */
export interface ProxyCue extends BaseCue {
  type: 'proxy';
  source: CueRef;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpCue extends BaseCue {
  type: 'http';
  name: string;
  color: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Action a timer cue performs on the single global timer slot. */
export type TimerAction = 'set' | 'pause' | 'resume' | 'clear';

export interface TimerCue extends BaseCue {
  type: 'timer';
  name: string;
  color: string;
  action: TimerAction;
  /** Duration in seconds; used when action is "set". */
  duration: number;
}

/** Action a video cue performs on the single global video slot. */
export type VideoAction = 'play' | 'pause' | 'resume' | 'clear';

/** How a clip fills the screen: letterboxed whole, or cropped to fill. */
export type VideoFit = 'contain' | 'cover';

/**
 * Puts a clip on the screen window (or controls the one already there). Like the
 * timer there is exactly one video slot for the whole app, and video takes the
 * screen over from the timer for as long as it holds it.
 */
export interface VideoCue extends BaseCue {
  type: 'video';
  name: string;
  color: string;
  action: VideoAction;
  /** Filename relative to the project folder; used when action is "play". */
  file: string;
  /** Seconds into the file to start from. Absent (older saves) reads as 0. */
  startTime: number;
  /** Seconds into the file to stop at, or null for end-of-file. Absent (older
   *  saves) reads as null. */
  endTime: number | null;
  /** Fade-in duration in seconds, ramping the clip's own audio track up from
   *  silence. Absent (older saves) reads as 0. */
  fadeIn: number;
  /** Fade-out duration in seconds. Absent (older saves) reads as 0. */
  fadeOut: number;
  /**
   * Also fade out when the clip reaches its own out point (end of file, or
   * `endTime`), not just when it's manually taken off screen. The fade lands
   * exactly on the out point. Ignored while looping, which never reaches an
   * end. Absent (older saves) reads as false, preserving the previous
   * hard-cut behaviour. Manually pausing or clearing the screen stays instant
   * either way — only the clip's own natural end fades.
   */
  fadeOutOnEnd?: boolean;
  loop: boolean;
  /**
   * 0..1, applied to the clip's own audio track. Video plays through the screen
   * window's media element rather than the Web Audio graph, so this is
   * independent of master volume and of every audio cue's level.
   */
  volume: number;
  muted: boolean;
  fit: VideoFit;
  /**
   * What clicking the cue again does while its clip holds the screen, mirroring
   * an audio cue's toggle: "stop" takes the picture off, "pause" holds the frame
   * so a third click resumes it. Only applies to the "play" action — the control
   * actions mean exactly what they say. Absent (older saves) reads as "stop".
   */
  onStopBehavior: StopBehavior;
}

/**
 * What a global cue does to every audio cue in scope. These mirror the
 * equivalent trigger actions, but need no target — the target is "everything".
 */
export type GlobalAction = 'stop' | 'pause' | 'resume';

/**
 * How wide a global cue reaches. Documents are separate shows, so stopping
 * "everything" normally means everything in *this* file; 'all' is the panic
 * button that reaches across every open document too.
 */
export type GlobalScope = 'document' | 'all';

/** Applies one action to every audio cue in scope at once. */
export interface GlobalCue extends BaseCue {
  type: 'global';
  name: string;
  color: string;
  action: GlobalAction;
  /** Use each affected cue's own configured fade, rather than acting instantly. */
  fade: boolean;
  scope: GlobalScope;
}

export type Cue = AudioCue | ProxyCue | HttpCue | TimerCue | VideoCue | GlobalCue;

export interface Tab {
  id: string;
  name: string;
  cues: Cue[];
}

export interface GridSize {
  rows: number;
  cols: number;
}

export interface Project {
  version: number;
  grid: GridSize;
  masterVolume: number;
  tabs: Tab[];
}

export const PROJECT_VERSION = 1;

/** Runtime playback state for a playable (audio) cue. */
export type PlaybackState = 'idle' | 'fadingIn' | 'playing' | 'fadingOut';

// ---- Defaults / factories ------------------------------------------------

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function defaultProject(): Project {
  return {
    version: PROJECT_VERSION,
    grid: { rows: 4, cols: 8 },
    masterVolume: 1,
    tabs: [{ id: makeId('tab'), name: 'Tab 1', cues: [] }],
  };
}

export function defaultAudioCue(row: number, col: number): AudioCue {
  return {
    id: makeId('cue'),
    type: 'audio',
    row,
    col,
    triggers: [],
    name: '',
    color: '#3b82f6',
    file: '',
    startTime: 0,
    endTime: null,
    fadeIn: 0,
    fadeOut: 0.5,
    fadeOutOnEnd: false,
    volume: 1,
    loop: false,
    onStopBehavior: 'stop',
  };
}

export function defaultProxyCue(row: number, col: number): ProxyCue {
  return {
    id: makeId('cue'),
    type: 'proxy',
    row,
    col,
    triggers: [],
    source: { cueId: '' },
  };
}

export function defaultTimerCue(row: number, col: number): TimerCue {
  return {
    id: makeId('cue'),
    type: 'timer',
    row,
    col,
    triggers: [],
    name: '',
    color: '#8b5cf6',
    action: 'set',
    duration: 300,
  };
}

export function defaultVideoCue(row: number, col: number): VideoCue {
  return {
    id: makeId('cue'),
    type: 'video',
    row,
    col,
    triggers: [],
    name: '',
    color: '#0ea5e9',
    action: 'play',
    file: '',
    startTime: 0,
    endTime: null,
    fadeIn: 0,
    fadeOut: 0,
    fadeOutOnEnd: false,
    loop: false,
    volume: 1,
    muted: false,
    fit: 'contain',
    onStopBehavior: 'stop',
  };
}

export function defaultGlobalCue(row: number, col: number): GlobalCue {
  return {
    id: makeId('cue'),
    type: 'global',
    row,
    col,
    triggers: [],
    name: 'Stop all',
    color: '#ef4444',
    action: 'stop',
    fade: true,
    scope: 'document',
  };
}

export function defaultHttpCue(row: number, col: number): HttpCue {
  return {
    id: makeId('cue'),
    type: 'http',
    row,
    col,
    triggers: [],
    name: 'HTTP',
    color: '#f59e0b',
    method: 'GET',
    url: '',
    headers: {},
    body: '',
  };
}
