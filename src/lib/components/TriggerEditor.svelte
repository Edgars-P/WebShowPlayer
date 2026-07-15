<script lang="ts">
  import { app } from '../state/project.svelte';
  import type { Cue, TriggerAction, TriggerEvent } from '../types';
  import CuePicker from './CuePicker.svelte';

  let { cue }: { cue: Cue } = $props();

  function addTrigger() {
    const firstTab = app.activeTab?.id ?? app.project?.tabs[0]?.id ?? '';
    cue.triggers.push({
      event: 'onStart',
      target: { tab: firstTab, row: 0, col: 0 },
      action: 'start',
    });
    app.markDirty();
  }

  function remove(i: number) {
    cue.triggers.splice(i, 1);
    app.markDirty();
  }
</script>

<div class="triggers">
  <div class="row head">
    <label>Triggers</label>
    <button class="ghost" onclick={addTrigger}>+ Add</button>
  </div>

  {#each cue.triggers as trig, i (i)}
    <div class="trig">
      <div class="line">
        <select bind:value={trig.event} onchange={() => app.markDirty()}>
          <option value={'onStart' as TriggerEvent}>After start</option>
          <option value={'onStop' as TriggerEvent}>After stop</option>
        </select>
        <select bind:value={trig.action} onchange={() => app.markDirty()}>
          <option value={'click' as TriggerAction}>click</option>
          <option value={'start' as TriggerAction}>start</option>
          <option value={'stop' as TriggerAction}>stop</option>
        </select>
        <button class="x" title="Remove" onclick={() => remove(i)}>×</button>
      </div>
      <CuePicker target={trig.target} />
    </div>
  {/each}

  {#if cue.triggers.length === 0}
    <p class="empty">No triggers.</p>
  {/if}
</div>

<style>
  .triggers {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    justify-content: space-between;
  }
  .trig {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .line {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .line select {
    flex: 1;
    min-width: 0;
  }
  .x {
    border: none;
    background: transparent;
    color: var(--muted);
    padding: 2px 6px;
  }
  .x:hover {
    color: var(--danger);
  }
  .empty {
    color: var(--muted);
    font-size: 12px;
    margin: 0;
  }
</style>
