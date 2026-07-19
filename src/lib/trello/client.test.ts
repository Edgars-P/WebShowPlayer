// Parsing what the user pastes, building the request, and reading the response.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchFirstList,
  isDone,
  labelColor,
  labelTitle,
  listsUrl,
  parseBoardRef,
  TrelloError,
} from './client';
import { authorizeUrl } from '../state/trello.svelte';

const card = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Atrastās mantas',
  labels: [],
  dueComplete: false,
  ...over,
});

/** Stub `fetch` with one canned response, returning the calls it received. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseBoardRef', () => {
  it('takes the short link out of a board URL', () => {
    expect(parseBoardRef('https://trello.com/b/dGaUdOP1/abfs-dztv')).toBe('dGaUdOP1');
  });

  it('accepts a URL without the slug, and trims whitespace', () => {
    expect(parseBoardRef('  https://trello.com/b/dGaUdOP1  ')).toBe('dGaUdOP1');
  });

  it('accepts a bare short link or a full board id', () => {
    expect(parseBoardRef('dGaUdOP1')).toBe('dGaUdOP1');
    expect(parseBoardRef('5c96e8f0e0b7f5a1a1a1a1a1')).toBe('5c96e8f0e0b7f5a1a1a1a1a1');
  });

  it('rejects empty input and things that are not identifiers', () => {
    expect(parseBoardRef('')).toBeNull();
    expect(parseBoardRef('   ')).toBeNull();
    expect(parseBoardRef('short')).toBeNull();
    expect(parseBoardRef('https://example.com/b/dGaUdOP1')).toBeNull();
  });
});

describe('listsUrl', () => {
  it('asks for open cards with only the fields the sidebar draws', () => {
    const url = new URL(listsUrl('dGaUdOP1', 'KEY', 'TOKEN'));
    expect(url.origin + url.pathname).toBe('https://api.trello.com/1/boards/dGaUdOP1/lists');
    expect(url.searchParams.get('cards')).toBe('open');
    expect(url.searchParams.get('filter')).toBe('open');
    expect(url.searchParams.get('card_fields')).toBe('name,labels,dueComplete');
    expect(url.searchParams.get('key')).toBe('KEY');
    expect(url.searchParams.get('token')).toBe('TOKEN');
  });
});

describe('fetchFirstList', () => {
  it('returns only the first list, with its cards', async () => {
    const calls = stubFetch([
      { id: 'l1', name: '19. Jūl (4. Diena)', cards: [card(), card({ id: 'c2' })] },
      { id: 'l2', name: 'Later', cards: [card({ id: 'c3' })] },
    ]);

    const list = await fetchFirstList('board', 'k', 't');

    expect(calls).toHaveLength(1);
    expect(list?.name).toBe('19. Jūl (4. Diena)');
    expect(list?.cards.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('treats a list with no cards key as an empty list', async () => {
    stubFetch([{ id: 'l1', name: 'Empty' }]);
    expect((await fetchFirstList('board', 'k', 't'))?.cards).toEqual([]);
  });

  it('returns null for a board with no lists', async () => {
    stubFetch([]);
    expect(await fetchFirstList('board', 'k', 't')).toBeNull();
  });

  it('reports bad credentials as an auth error', async () => {
    stubFetch(null, false, 401);
    const err = await fetchFirstList('board', 'k', 't').catch((e) => e);
    expect(err).toBeInstanceOf(TrelloError);
    expect((err as TrelloError).isAuth).toBe(true);
    expect((err as TrelloError).message).toMatch(/key or token/i);
  });

  it('reports a missing board without blaming the credentials', async () => {
    stubFetch(null, false, 404);
    const err = await fetchFirstList('board', 'k', 't').catch((e) => e);
    expect((err as TrelloError).status).toBe(404);
    expect((err as TrelloError).isAuth).toBe(false);
  });
});

describe('card presentation', () => {
  it('maps palette names to hex, including light and dark variants', () => {
    expect(labelColor('green')).toBe('#4bce97');
    expect(labelColor('purple')).toBe('#9f8fef');
    expect(labelColor('orange')).toBe('#fea362');
    expect(labelColor('blue_dark')).toBe('#0c66e4');
  });

  it('falls back to grey for colourless and unknown labels', () => {
    const grey = labelColor(null);
    expect(grey).toMatch(/^#[0-9a-f]{6}$/);
    expect(labelColor('chartreuse')).toBe(grey);
  });

  it('names a label by its text, or by its colour when unnamed', () => {
    expect(labelTitle({ id: 'x', name: 'Mūzika', color: 'green' })).toBe('Mūzika');
    expect(labelTitle({ id: 'x', name: '', color: 'purple_dark' })).toBe('purple dark');
    expect(labelTitle({ id: 'x', name: '', color: null })).toBe('no colour');
  });

  it('reads completion from dueComplete only', () => {
    expect(isDone(card())).toBe(false);
    expect(isDone(card({ dueComplete: true }))).toBe(true);
  });
});

describe('authorizeUrl', () => {
  it('requests a never-expiring read-only token for the given key', () => {
    const url = new URL(authorizeUrl('KEY'));
    expect(url.searchParams.get('key')).toBe('KEY');
    expect(url.searchParams.get('scope')).toBe('read');
    expect(url.searchParams.get('expiration')).toBe('never');
    expect(url.searchParams.get('response_type')).toBe('token');
  });
});
