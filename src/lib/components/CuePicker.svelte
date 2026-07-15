<script lang="ts">
  import { app } from '../state/project.svelte';
  import type { Cue, CueRef } from '../types';

  // `target` is a reactive CueRef from the project; we mutate its fields in place.
  let { target }: { target: CueRef } = $props();

  let open = $state(false);
  let rect = $state<{ left: number; top: number; width: number } | null>(null);

  let selected = $derived(app.resolveRef(target));
  let selectedTab = $derived(selected ? app.tabOf(selected) : null);

  let groups = $derived(
    (app.project?.tabs ?? []).map((t) => ({
      tab: t,
      cues: [...t.cues].sort((a, b) => a.row - b.row || a.col - b.col),
    })),
  );

  function toggle(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    rect = { left: r.left, top: r.bottom + 4, width: Math.max(r.width, 240) };
    open = !open;
  }

  function choose(cue: Cue) {
    target.cueId = cue.id;
    app.markDirty();
    open = false;
  }

  function typeBadge(cue: Cue): string {
    return cue.type === 'audio' ? '' : cue.type.toUpperCase();
  }
</script>

<button type="button" class="picker" onclick={toggle}>
  {#if selected}
    {@const info = app.display(selected)}
    <span class="swatch" style:background={info.color}></span>
    <span class="name">{info.name || '(unnamed)'}</span>
    <span class="meta">{selectedTab?.name} · {selected.row},{selected.col}</span>
  {:else}
    <span class="placeholder">Choose target…</span>
  {/if}
  <span class="chev">▾</span>
</button>

{#if open && rect}
  <div class="backdrop" onclick={() => (open = false)} role="presentation"></div>
  <div
    class="dropdown"
    style:left={`${rect.left}px`}
    style:top={`${rect.top}px`}
    style:width={`${rect.width}px`}
    role="listbox"
  >
    {#each groups as g (g.tab.id)}
      <div class="group">{g.tab.name}</div>
      {#if g.cues.length === 0}
        <div class="none">— empty —</div>
      {/if}
      {#each g.cues as cue (cue.id)}
        {@const info = app.display(cue)}
        <button
          type="button"
          class="card"
          class:sel={selected?.id === cue.id}
          onclick={() => choose(cue)}
        >
          <span class="swatch" style:background={info.color}></span>
          <span class="name">{info.name || '(unnamed)'}</span>
          {#if typeBadge(cue)}<span class="tbadge">{typeBadge(cue)}</span>{/if}
          <span class="meta">{cue.row},{cue.col}</span>
        </button>
      {/each}
    {/each}
  </div>
{/if}

<style>
  .picker {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
  }
  .swatch {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    flex-shrink: 0;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--muted);
    font-size: 11px;
    flex-shrink: 0;
  }
  .placeholder {
    flex: 1;
    color: var(--muted);
  }
  .chev {
    color: var(--muted);
    font-size: 11px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .dropdown {
    position: fixed;
    z-index: 61;
    max-height: 300px;
    overflow-y: auto;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  }
  .group {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    padding: 6px 8px 2px;
  }
  .none {
    color: var(--muted);
    font-size: 12px;
    padding: 2px 10px 6px;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 6px 8px;
    border-radius: 5px;
  }
  .card:hover {
    background: var(--accent);
    color: white;
  }
  .card.sel {
    outline: 1px solid var(--accent);
  }
  .tbadge {
    font-size: 9px;
    font-weight: 700;
    background: rgba(0, 0, 0, 0.35);
    padding: 1px 4px;
    border-radius: 4px;
    flex-shrink: 0;
  }
</style>
