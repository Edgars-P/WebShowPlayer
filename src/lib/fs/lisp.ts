// Best-effort conversion from Linux Show Player (LiSP, ".lsp") sessions.
//
// LiSP CartLayout stores cues with a global `index` = cart slot across pages,
// laid out 7 columns x 4 rows per page (its default grid). `session.layout.tabs`
// names the pages. We convert GstMediaCue -> audio cue; other cue types
// (CommandCue, CollectionCue, StopAll, VolumeControl) can't be represented and
// are skipped.

import {
  makeId,
  PROJECT_VERSION,
  type AudioCue,
  type Project,
  type Tab,
  type Trigger,
  type TriggerAction,
  type TriggerEvent,
} from '../types';

const COLS = 7;
const ROWS = 4;
const PER_PAGE = COLS * ROWS;

const EVENT_MAP: Record<string, TriggerEvent> = {
  Started: 'onStart',
  Stopped: 'onStop',
  Ended: 'onStop',
};

/** Does this look like a LiSP session rather than a native project? */
export function looksLikeLisp(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    Array.isArray((data as { cues?: unknown }).cues) &&
    'session' in (data as object)
  );
}

export function convertLisp(data: unknown): Project {
  const root = (data ?? {}) as {
    cues?: unknown;
    session?: { layout?: { tabs?: unknown } };
  };
  const tabNames = Array.isArray(root.session?.layout?.tabs)
    ? (root.session!.layout!.tabs as unknown[]).map((t) => String(t))
    : ['Page 1'];
  const tabs: Tab[] = tabNames.map((name) => ({ id: makeId('tab'), name, cues: [] }));

  const ensureTab = (page: number): number => {
    while (tabs.length <= page) tabs.push({ id: makeId('tab'), name: `Page ${tabs.length + 1}`, cues: [] });
    return page;
  };

  const lispCues = Array.isArray(root.cues) ? (root.cues as Record<string, unknown>[]) : [];
  const idMap = new Map<string, string>(); // LiSP cue id -> our cue id
  const converted: { cue: AudioCue; lisp: Record<string, unknown> }[] = [];

  // First pass: place each media cue and remember its LiSP id -> our id.
  for (const lc of lispCues) {
    if (lc._type_ !== 'GstMediaCue') continue;
    const index = typeof lc.index === 'number' ? lc.index : 0;
    const page = ensureTab(Math.floor(index / PER_PAGE));
    const slot = index % PER_PAGE;
    const row = Math.floor(slot / COLS);
    const col = slot % COLS;
    const cue = toAudioCue(lc, row, col);
    tabs[page].cues.push(cue);
    if (typeof lc.id === 'string') idMap.set(lc.id, cue.id);
    converted.push({ cue, lisp: lc });
  }

  // Second pass: resolve triggers now that every cue has an id.
  for (const { cue, lisp } of converted) {
    cue.triggers = convertTriggers(lisp, idMap);
  }

  return { version: PROJECT_VERSION, grid: { rows: ROWS, cols: COLS }, masterVolume: 1, tabs };
}

function toAudioCue(lc: Record<string, unknown>, row: number, col: number): AudioCue {
  const media = lc.media as { elements?: Record<string, Record<string, unknown>> } | undefined;
  const uri = (media?.elements?.UriInput?.uri as string | undefined) ?? '';
  const volume = media?.elements?.Volume?.volume;
  return {
    id: makeId('cue'),
    type: 'audio',
    row,
    col,
    triggers: [],
    name: typeof lc.name === 'string' ? lc.name : '',
    color: '#3b82f6',
    file: normalizeUri(uri),
    startTime: 0,
    endTime: null,
    fadeIn: num(lc.fadein_duration, 0),
    fadeOut: num(lc.fadeout_duration, 0),
    volume: typeof volume === 'number' ? Math.min(1, Math.max(0, volume)) : 1,
    loop: false,
    onStopBehavior: 'stop',
  };
}

/** Turn a LiSP media URI into a folder-relative path (best-effort). */
function normalizeUri(uri: string): string {
  let u = String(uri).trim().replace(/^file:\/\//, '');
  try {
    u = decodeURI(u);
  } catch {
    /* keep raw */
  }
  // Drop drive letters, leading slashes, and any leading ../ or ./ segments.
  u = u.replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/');
  u = u.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '').replace(/^\/+/, '');
  return u;
}

function convertTriggers(lc: Record<string, unknown>, idMap: Map<string, string>): Trigger[] {
  const out: Trigger[] = [];
  const triggers = lc.triggers;
  if (!triggers || typeof triggers !== 'object') return out;
  for (const [evtName, list] of Object.entries(triggers as Record<string, unknown>)) {
    const event = EVENT_MAP[evtName];
    if (!event || !Array.isArray(list)) continue;
    for (const pair of list) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const cueId = idMap.get(String(pair[0]));
      if (!cueId) continue;
      out.push({
        events: [event],
        action: mapAction(String(pair[1])),
        target: { cueId },
      });
    }
  }
  return out;
}

function mapAction(a: string): TriggerAction {
  return /stop|pause/i.test(a) ? 'stop' : 'start';
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}
