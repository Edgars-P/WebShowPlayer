<script lang="ts">
  // The panel that appears on a tile when you hover a *different* cue whose
  // triggers reach it: what that cue would do to this one, and when.
  //
  // Its own component rather than part of CueButton, and not only for size. It
  // is a second little state machine living on the same tile as the playback
  // one, with its own idea of what "on", "now" and "active" mean — and Svelte
  // scopes styles per component, not per subtree, so sharing a file meant
  // sharing a namespace. That collided exactly once (a hint row's `.on` picking
  // up the cue fill's `.on` background) and would have gone on colliding. Split,
  // the two vocabularies simply cannot reach each other.
  import { fade } from 'svelte/transition';
  import type { TriggerHint } from '../state/doc.svelte';
  import type { TriggerAction, TriggerEvent } from '../types';
  import type { Component } from 'svelte';
  import IconPlayFill from '~icons/bi/play-fill';
  import IconPlay from '~icons/bi/play';
  import IconPauseFill from '~icons/bi/pause-fill';
  import IconStopFill from '~icons/bi/stop-fill';
  import IconSkipEnd from '~icons/bi/skip-end-fill';
  import IconClick from '~icons/bi/record-circle';
  import IconStopwatchFill from '~icons/bi/stopwatch-fill';
  import IconClear from '~icons/bi/slash-circle';

  /** Matches the tile's own highlight transition, so ring and panel move together. */
  const FADE_MS = 120;

  let { hints }: { hints: TriggerHint[] } = $props();

  /**
   * Every event gets a row, in the cue's own lifecycle order, whether or not
   * anything hangs off it. A cue's rows therefore sit in the same place on every
   * tile and on every hover — only their colour changes — so the eye can learn
   * "second row means on pause" instead of re-reading a list that reshuffles
   * itself with each cue you point at.
   */
  const EVENT_ORDER: TriggerEvent[] = ['onStart', 'onPause', 'onStop', 'onEnd'];

  // Filled glyphs = a definite transport action; hollow = a softer variant, so
  // start/resume and stop/pause stay distinguishable at 10px.
  const EVENT_GLYPH: Record<TriggerEvent, Component> = {
    onStart: IconPlayFill,
    onPause: IconPauseFill,
    onStop: IconStopFill,
    onEnd: IconSkipEnd,
  };
  const ACTION_GLYPH: Record<TriggerAction, Component> = {
    click: IconClick,
    start: IconPlayFill,
    resume: IconPlay,
    pause: IconPauseFill,
    stop: IconStopFill,
    set: IconStopwatchFill,
    clear: IconClear,
  };
  const EVENT_WORD = {
    onStart: 'when it starts',
    onPause: 'when it pauses',
    onStop: 'when it stops',
    onEnd: 'when it ends',
  } as const;

  function hintsFor(event: TriggerEvent): TriggerHint[] {
    return hints.filter((h) => h.event === event);
  }

  function hintTitle(event: TriggerEvent): string {
    const list = hintsFor(event);
    if (!list.length) return `${EVENT_WORD[event]}, nothing happens to this cue`;
    const actions = list.map((h) => h.action).join(', ');
    return `${EVENT_WORD[event]}, ${actions} this cue${list[0].now ? ' — this click' : ''}`;
  }
</script>

{#if hints.length}
  <span class="hints" transition:fade={{ duration: FADE_MS }}>
    {#each EVENT_ORDER as event (event)}
      {@const list = hintsFor(event)}
      {@const WhenIcon = EVENT_GLYPH[event]}
      {@const WhatIcon = list.length ? ACTION_GLYPH[list[0].action] : null}
      <span class="slot" class:acts={list.length > 0} class:now={list[0]?.now} title={hintTitle(event)}>
        <span class="box when"><WhenIcon /></span>
        <span class="box what">{#if WhatIcon}<WhatIcon />{/if}</span>
      </span>
    {/each}
  </span>
{/if}

<style>
  /* Tucked into the top-right corner of the tile, clear of the name and time in
     the middle. Positions itself against the tile: the nearest positioned
     ancestor is CueButton's own card, across the component boundary. */
  .hints {
    /* One hue for the whole panel, taken from the app accent and stepped through
       in OKLCH — the same trick the tile itself uses, for the same reason: with
       hue and chroma held still, a step in lightness is a step in emphasis and
       nothing else, so the ladder can be read without being decoded.

       Deliberately *not* derived from any cue colour. The panel floats over
       whichever tile is underneath — any hue, and anywhere between empty and
       fully filled — and a scheme mixed from the tile's colour, or from the
       colour of the cue driving it, would have to stay legible against every
       combination of the two. Bringing its own ground is what lets colour here
       be redundant with brightness, which is what lets it work at 10px.

       Four rungs, quietest first: an empty slot, its label, a slot something
       happens in, and the one thing this very click fires. The accent's own
       mid-lightness is deliberately absent — it was the old scheme's failure,
       too dark to take white glyphs and too light to sit on the panel. */
    --hint-bg: oklch(from var(--accent) 0.17 calc(c * 0.3) h);
    --hint-edge: oklch(from var(--accent) 0.32 calc(c * 0.4) h);
    --slot-empty: oklch(from var(--accent) 0.26 calc(c * 0.25) h);
    --ink-empty: oklch(from var(--accent) 0.52 calc(c * 0.3) h);
    --slot-later: oklch(from var(--accent) 0.42 calc(c * 0.55) h);
    --ink-later: oklch(from var(--accent) 0.96 calc(c * 0.1) h);
    --slot-now: oklch(from var(--accent) 0.86 c h);
    --ink-now: oklch(from var(--accent) 0.2 calc(c * 0.5) h);
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    padding: 3px;
    border-radius: 6px;
    /* Opaque: any transparency here lets the tile's own fill through and takes
       the contrast with it, which is exactly what the panel exists to prevent. */
    background: var(--hint-bg);
    border: 1px solid var(--hint-edge);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .slot {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    font-size: 10px;
    line-height: 1;
    border-radius: 3px;
  }

  /* Rows that do nothing are still drawn, holding the position of the ones that
     do — the empty rows are what make a lit one's position mean anything. They
     get their own rung rather than being the lit style faded out: a blanket
     opacity dims the slot, its glyph and the panel's own ground by the same
     amount, which leaves the row muddy instead of quiet. */
  .when {
    color: var(--ink-empty);
  }
  .what {
    background: var(--slot-empty);
    /* The slot still shows; there is simply nothing in it. */
    color: transparent;
  }
  /* Something happens here, later in the hovered cue's life. */
  .slot.acts .when {
    color: var(--ink-later);
  }
  .slot.acts .what {
    background: var(--slot-later);
    color: var(--ink-later);
  }
  /* ...and this one goes off on the click the pointer is already resting on:
     the top rung, and the only place in the panel where the ink is darker than
     what it sits on. */
  .slot.now .when {
    color: var(--slot-now);
  }
  .slot.now .what {
    background: var(--slot-now);
    color: var(--ink-now);
    font-weight: 700;
  }
</style>
