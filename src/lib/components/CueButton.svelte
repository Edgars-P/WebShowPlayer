<script lang="ts">
  import { app } from '../state/project.svelte';
  import { formatTime } from '../timer/timer';
  import type { Cue } from '../types';

  let { cue }: { cue: Cue } = $props();

  let info = $derived(app.display(cue));
  let flash = $derived(app.httpFlashes[cue.id]);
  let active = $derived(info.state !== 'idle');
  // Resolve to the real audio cue (self, or a proxy's source) to read live level.
  let audioTarget = $derived(active ? app.resolveProxy(cue) : null);
  let glow = $derived(audioTarget?.type === 'audio' ? app.level(audioTarget) : 0);

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
  style:--cue-bg={info.missing ? '#3a2020' : info.color}
  style:--cue-fg={fg(info.missing ? '#3a2020' : info.color)}
  style:--glow={glow}
  draggable="true"
  ondragstart={onDragStart}
  onclick={onClick}
  title={info.missing ? 'Media missing' : info.name}
>
  <span class="badges">
    {#if cue.type === 'proxy'}<span class="badge">⇄</span>{/if}
    {#if cue.type === 'http'}<span class="badge">HTTP</span>{/if}
    {#if cue.type === 'timer'}<span class="badge">⏱ {cue.action}</span>{/if}
  </span>

  <span class="label"
    >{info.name || (cue.type === 'http' ? 'HTTP' : cue.type === 'timer' ? 'Timer' : '—')}</span
  >

  {#if cue.type === 'timer'}
    <span class="state">{cue.action === 'set' ? formatTime(cue.duration) : cue.action}</span>
  {/if}

  {#if cue.type === 'audio' || cue.type === 'proxy'}
    <span class="state">{active ? info.state : ''}</span>
    {#if active}
      {@const target = app.resolveProxy(cue)}
      {#if target && target.type === 'audio'}
        <span class="progress" style:width={`${app.progress(target) * 100}%`}></span>
      {/if}
    {/if}
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
  .label {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.15;
    word-break: break-word;
  }
  .state {
    font-size: 10px;
    opacity: 0.75;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    min-height: 12px;
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
