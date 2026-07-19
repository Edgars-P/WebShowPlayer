// Minimal read-only Trello REST client, running entirely in the browser.
//
// The API answers with `Access-Control-Allow-Origin: *`, so the fetches below
// go straight from the page to api.trello.com with no proxy in between.
// Credentials are the operator's own API key plus a token they authorise once;
// both sit in localStorage, which puts them at the same trust level as the cue
// folder — anyone at this machine can read them.

const API = 'https://api.trello.com/1';

/** Only what the sidebar actually draws, to keep responses small. */
const CARD_FIELDS = 'name,labels,dueComplete';

export interface TrelloLabel {
  id: string;
  name: string;
  /** Palette name such as 'green' or 'purple_dark'; null for a colourless label. */
  color: string | null;
}

export interface TrelloCard {
  id: string;
  name: string;
  labels: TrelloLabel[];
  dueComplete: boolean;
}

export interface TrelloList {
  id: string;
  name: string;
  cards: TrelloCard[];
}

export class TrelloError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TrelloError';
  }

  /** Whether the failure is about the credentials rather than the board. */
  get isAuth(): boolean {
    return this.status === 401;
  }
}

/**
 * Pull a board identifier out of whatever the user pasted: a full board URL, a
 * bare short link, or a 24-character board id. Returns null if it's neither.
 */
export function parseBoardRef(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const url = s.match(/trello\.com\/b\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  // Short links are 8 chars, full ids 24 hex; accept anything in that shape.
  if (/^[A-Za-z0-9]{8,24}$/.test(s)) return s;
  return null;
}

/** Build the request URL. Split out so a test can assert it without fetching. */
export function listsUrl(board: string, key: string, token: string): string {
  const q = new URLSearchParams({
    cards: 'open',
    card_fields: CARD_FIELDS,
    fields: 'id,name',
    filter: 'open',
    key,
    token,
  });
  return `${API}/boards/${encodeURIComponent(board)}/lists?${q}`;
}

/** Turn a failed response into a message worth showing in the sidebar. */
function describe(status: number): string {
  if (status === 401) return 'Trello rejected the API key or token. Check both in settings.';
  if (status === 404) return 'That board was not found, or the token cannot see it.';
  if (status === 429) return 'Trello is rate-limiting us. Backing off.';
  return `Trello returned HTTP ${status}.`;
}

/**
 * Fetch the board's first open list with its open cards. Returns null when the
 * board has no lists at all — an empty board is not an error.
 */
export async function fetchFirstList(
  board: string,
  key: string,
  token: string,
  signal?: AbortSignal,
): Promise<TrelloList | null> {
  const res = await fetch(listsUrl(board, key, token), { signal });
  if (!res.ok) throw new TrelloError(describe(res.status), res.status);

  const lists = (await res.json()) as TrelloList[];
  if (!Array.isArray(lists) || lists.length === 0) return null;

  const first = lists[0];
  return {
    id: first.id,
    name: first.name,
    // A list with no cards comes back without the key rather than as [].
    cards: Array.isArray(first.cards) ? first.cards : [],
  };
}

/**
 * Trello's label palette, as hex. The API only ever names a colour, so the
 * mapping has to live here; these track the current Atlassian palette that
 * Trello's own board view draws with.
 */
const LABEL_COLORS: Record<string, string> = {
  green: '#4bce97',
  yellow: '#f5cd47',
  orange: '#fea362',
  red: '#f87168',
  purple: '#9f8fef',
  blue: '#579dff',
  sky: '#6cc3e0',
  lime: '#94c748',
  pink: '#e774bb',
  black: '#8590a2',

  green_light: '#baf3db',
  yellow_light: '#f8e6a0',
  orange_light: '#fedec8',
  red_light: '#ffd5d2',
  purple_light: '#dfd8fd',
  blue_light: '#cce0ff',
  sky_light: '#c6edfb',
  lime_light: '#d3f1a7',
  pink_light: '#fdd0ec',
  black_light: '#dcdfe4',

  green_dark: '#1f845a',
  yellow_dark: '#946f00',
  orange_dark: '#c25100',
  red_dark: '#c9372c',
  purple_dark: '#6e5dc6',
  blue_dark: '#0c66e4',
  sky_dark: '#227d9b',
  lime_dark: '#5b7f24',
  pink_dark: '#ae4787',
  black_dark: '#626f86',
};

/** Hex for a label. Colourless labels get a neutral grey, as Trello shows them. */
export function labelColor(color: string | null): string {
  if (!color) return '#5d6472';
  return LABEL_COLORS[color] ?? '#5d6472';
}

/** Hover text for a label bar: its name, or the colour when it has none. */
export function labelTitle(label: TrelloLabel): string {
  if (label.name) return label.name;
  return label.color ? label.color.replace(/_/g, ' ') : 'no colour';
}

/**
 * Whether the card is ticked off. Trello's "mark as complete" on a card sets
 * `dueComplete`, which is what the board view strikes through.
 */
export function isDone(card: TrelloCard): boolean {
  return card.dueComplete === true;
}
