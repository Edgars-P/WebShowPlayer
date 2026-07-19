<script lang="ts">
  import { fade } from 'svelte/transition';
  import { app } from '../state/project.svelte';
  import { formatTime } from '../timer/timer';
  import type { Cue } from '../types';

  /** Matches the tile's own highlight transition, so ring and badges move together. */
  const HINT_FADE_MS = 120;

  let { cue }: { cue: Cue } = $props();

  let info = $derived(app.display(cue));
  let flash = $derived(app.httpFlashes[cue.id]);
  let active = $derived(info.state !== 'idle');
  // Resolve to the real audio cue (self, or a proxy's source) to read live level.
  let audioTarget = $derived(active ? app.resolveProxy(cue) : null);
  let glow = $derived(audioTarget?.type === 'audio' ? app.level(audioTarget) : 0);

  // What the hovered tile's triggers would do to this one — empty unless some
  // other tile is hovered and drives this one.
  let hints = $derived(app.previewTargets.get(cue.id) ?? []);
  // Blue when this click sets it off, grey when it happens later on.
  let hintNow = $derived(hints.some((h) => h.now));
  let isHovered = $derived(app.hoveredCueId === cue.id);

  // Filled glyphs = a definite transport action; hollow = a softer variant, so
  // start/resume and stop/pause stay distinguishable at 9px.
  const EVENT_GLYPH = {
    onStart: '▶',
    onPause: '⏸',
    onStop: '⏹',
    onEnd: '⇥',
  } as const;
  const ACTION_GLYPH = {
    click: '⊙',
    start: '▶',
    resume: '▷',
    pause: '⏸',
    stop: '⏹',
    set: '⏱',
    clear: '⊘',
  } as const;
  const EVENT_WORD = {
    onStart: 'when it starts',
    onPause: 'when it pauses',
    onStop: 'when it stops',
    onEnd: 'when it ends',
  } as const;

  function hintTitle(h: (typeof hints)[number]): string {
    return `${EVENT_WORD[h.event]}, ${h.action} this cue${h.now ? ' — this click' : ''}`;
  }

  const STATE_LABELS = {
    fadingIn: 'fading in',
    playing: 'playing',
    fadingOut: 'fading out',
    idle: '',
  } as const;

  function stateTitle(): string {
    if (info.state === 'fadingIn') return `${info.name} — click to bring it up to full now`;
    if (info.state === 'fadingOut') return `${info.name} — click to cut it out now`;
    return info.name;
  }

  function onClick(e: MouseEvent) {
    if (e.shiftKey) {
      // Shift-click: open properties.
      app.openProperties(cue.id);
      return;
    }
    app.activate(cue);
  }

  function onDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('text/cue-id', cue.id);
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  function fg(bg: string): string {
    // Pick readable text colour for the tile background.
    const m = /^#?([0-9a-f]{6})$/i.exec(bg);
    if (!m) return '#fff';
    const n = parseInt(m[1], 16);
    const lum = (0.299 * (n >> 16)) + (0.587 * ((n >> 8) & 255)) + (0.114 * (n & 255));
    return lum > 150 ? '#0e0f13' : '#fff';
  }
</script>

<button
  class="cue"
  class:active
  class:selected={app.propertiesCueId === cue.id}
  class:missing={info.missing}
  class:pending={info.pending}
  class:targeted={hints.length > 0}
  class:now={hintNow}
  class:hovering={isHovered}
  style:--cue-bg={info.missing ? '#3a2020' : info.color}
  style:--cue-fg={fg(info.missing ? '#3a2020' : info.color)}
  style:--glow={glow}
  draggable={app.dragModifier}
  ondragstart={onDragStart}
  onclick={onClick}
  onmouseenter={() => (app.hoveredCueId = cue.id)}
  onmouseleave={() => {
    if (app.hoveredCueId === cue.id) app.hoveredCueId = null;
  }}
  title={info.missing ? 'Media missing' : info.pending ? 'Loading media…' : stateTitle()}
>
  <span class="badges">
    {#if cue.type === 'proxy'}<span class="badge">⇄</span>{/if}
    {#if cue.type === 'http'}<span class="badge">HTTP</span>{/if}
    {#if cue.type === 'timer'}<span class="badge">⏱ {cue.action}</span>{/if}
    {#if cue.type === 'global'}
      <span class="badge" title={cue.scope === 'all' ? 'Every open cue file' : 'This cue file'}>
        {cue.scope === 'all' ? '◎' : '◉'} all{cue.fade ? '' : ' ⚡'}
      </span>
    {/if}
  </span>

  <span class="label"
    >{info.name || (cue.type === 'http' ? 'HTTP' : cue.type === 'timer' ? 'Timer' : '—')}</span
  >

  {#if cue.type === 'timer'}
    <span class="state">{cue.action === 'set' ? formatTime(cue.duration) : cue.action}</span>
  {/if}

  {#if cue.type === 'global'}
    <span class="state">{cue.action} all{cue.fade ? '' : ' · instant'}</span>
  {/if}

  {#if cue.type === 'audio' || cue.type === 'proxy'}
    <span class="state">
      {#if active}
        <span class="chip chip-{info.state}">
          <span class="row">
            <span class="glyph" aria-hidden="true">
              {info.state === 'playing' ? '▶' : info.state === 'fadingIn' ? '▲' : '▼'}
            </span>
            {STATE_LABELS[info.state]}
          </span>
          {#if info.state !== 'playing' && audioTarget?.type === 'audio'}
            <!-- The one moving thing here, and it's carrying information: how
                 much of the fade is left. -->
            <span class="fadebar">
              <span class="fill" style:width={`${app.fadeProgress(audioTarget) * 100}%`}></span>
            </span>
          {/if}
        </span>
      {:else if info.pending}
        <span class="chip chip-loading"><span class="row">loading</span></span>
      {/if}
    </span>
    {#if active}
      {@const target = app.resolveProxy(cue)}
      {#if target && target.type === 'audio'}
        <span class="progress" style:width={`${app.progress(target) * 100}%`}></span>
      {/if}
    {/if}
  {/if}

  {#if hints.length}
    <span class="hints" transition:fade={{ duration: HINT_FADE_MS }}>
      {#each hints as h, i (i)}
        <span class="hint" class:now={h.now} title={hintTitle(h)}>
          <span class="box when">{EVENT_GLYPH[h.event]}</span>
          <span class="box what">{ACTION_GLYPH[h.action]}</span>
        </span>
      {/each}
    </span>
  {/if}

  {#if flash}
    {#key flash.at}
      <span class="flash flash-{flash.state}"></span>
    {/key}
  {/if}
</button>

<style>
  .cue {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: var(--cue-bg);
    color: var(--cue-fg);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px;
    overflow: hidden;
    text-align: center;
    transition: filter 0.08s ease, box-shadow 0.07s linear;
    filter: brightness(0.82) saturate(0.9);
  }
  .cue:hover {
    filter: brightness(0.95);
  }
  .cue.active {
    /* Brightness and glow spread track the live output loudness (--glow 0..1). */
    filter: brightness(calc(1.08 + var(--glow, 0) * 0.5)) saturate(1.15);
    box-shadow:
      0 0 0 2px rgba(255, 255, 255, 0.5),
      0 0 calc(8px + var(--glow, 0) * 44px) var(--cue-bg);
  }
  .cue.selected {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }
  .cue.missing {
    border-style: dashed;
    border-color: var(--danger);
  }
  /* Still decoding: keep the cue's own colour — it isn't broken, just not ready
     yet — held back so it reads as not-yet-available. Static: the "loading"
     label already says it's working, and a pulse would add motion the eye keeps
     checking without learning anything from. */
  .cue.pending {
    filter: brightness(0.6) saturate(0.6);
  }
  .label {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.15;
    word-break: break-word;
  }
  /* Reserves the row so tiles don't reflow as cues start and stop. */
  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 16px;
  }
  /* Every state reads as a static glyph plus a word. The only thing that moves
     is the fade bar below, and it moves because its position *is* the
     information — how much of the fade is left. */
  .chip {
    display: inline-flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(2px);
    line-height: 1;
  }
  .chip .row {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }
  .glyph {
    font-size: 8px;
    line-height: 1;
  }
  .chip-loading {
    opacity: 0.7;
  }
  .chip-fadingOut {
    background: rgba(0, 0, 0, 0.45);
  }

  /* Fade progress: fills as the fade completes, so the bar is empty the instant
     it starts and full as it lands. */
  .fadebar {
    display: block;
    height: 2px;
    border-radius: 1px;
    background: rgba(255, 255, 255, 0.22);
    overflow: hidden;
  }
  .fadebar .fill {
    display: block;
    height: 100%;
    background: currentColor;
  }

  /* Hovering a cue marks up every tile it drives. Nothing shows at rest, so the
     grid stays clean and the badges can afford to be legible when they do
     appear. Colour carries the timing: blue for what this click fires, faded
     grey for what happens later in the hovered cue's life. */
  /* Drawn as a pseudo-element border rather than box-shadow or outline: a
     targeted cue may also be playing (box-shadow carries the level glow) or
     selected (outline), and this must never take either of those away. It also
     stays deliberately quieter than the hovered cue's own highlight — the
     badges carry the detail, this only says "and this one". */
  /* The ring is always present but transparent, so adding .targeted fades it in
     over the same 120ms as the badges. Creating the pseudo-element only when
     targeted would give the transition nothing to start from, and it would pop. */
  .cue::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease;
    /* Two-tone ring: a light line backed by a darker one. Any single colour
       fails on some cue — the accent disappeared on audio cues, which default
       to the same blue — but a light/dark pair keeps contrast on every hue,
       so it can stay faint without ever vanishing. */
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.34),
      inset 0 0 0 2px rgba(0, 0, 0, 0.28);
  }
  .cue.targeted::after {
    opacity: 1;
  }
  /* Imminent: thicker and brighter, tinted just enough to keep the blue
     association the badges carry, without relying on hue to be seen. */
  .cue.targeted.now::after {
    box-shadow:
      inset 0 0 0 2px rgba(219, 234, 254, 0.92),
      inset 0 0 0 3px rgba(0, 0, 0, 0.35);
  }

  /* Tucked into the top-right corner, clear of the type badges opposite and of
     the name and playback state in the middle. The panel gives the glyphs their
     own dark ground so they read the same on every tile, instead of sitting
     directly on a cue colour they'd otherwise blend into. */
  .hints {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    padding: 3px;
    border-radius: 6px;
    background: rgba(8, 10, 14, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    pointer-events: none;
  }
  .hint {
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
    /* The panel already supplies the contrast, so the chips stay flat. */
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.7);
  }
  /* The event box says merely when; the action box is the payload. */
  .hint .what {
    background: rgba(255, 255, 255, 0.16);
    color: #fff;
  }
  .hint.now .when {
    color: var(--accent);
  }
  .hint.now .what {
    background: var(--accent);
    color: #fff;
  }

  .badges {
    position: absolute;
    top: 4px;
    left: 4px;
    display: flex;
    gap: 3px;
  }
  .badge {
    font-size: 9px;
    font-weight: 700;
    background: rgba(0, 0, 0, 0.35);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .progress {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.9);
  }
  .flash {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .flash-ok {
    animation: flashfade 0.6s ease-out;
    background: var(--ok);
  }
  .flash-error {
    animation: flashfade 0.6s ease-out;
    background: var(--danger);
  }
  .flash-firing {
    background: rgba(255, 255, 255, 0.25);
  }
  @keyframes flashfade {
    from {
      opacity: 0.75;
    }
    to {
      opacity: 0;
    }
  }
</style>
