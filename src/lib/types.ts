// Data model for the launchpad player. Cues are a discriminated union on `type`.

export type CueType = 'audio' | 'proxy' | 'http' | 'timer';

/** Address of another cue by tab id + grid position. */
export interface CueRef {
  tab: string;
  row: number;
  col: number;
}

export type TriggerEvent = 'onStart' | 'onStop';
export type TriggerAction = 'click' | 'start' | 'stop';

export interface Trigger {
  event: TriggerEvent;
  target: CueRef;
  action: TriggerAction;
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
  /** Per-cue gain, 0..1. */
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

export type Cue = AudioCue | ProxyCue | HttpCue | TimerCue;

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

let idCounter = 0;
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
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
    source: { tab: '', row: 0, col: 0 },
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
