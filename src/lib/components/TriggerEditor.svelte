<script lang="ts">
  import { app } from '../state/project.svelte';
  import type { Cue, CueRef, Trigger, TriggerAction, TriggerEvent } from '../types';
  import CuePicker from './CuePicker.svelte';

  let { cue }: { cue: Cue } = $props();

  const EVENTS_BY_TYPE: Record<Cue['type'], { value: TriggerEvent; label: string }[]> = {
    audio: [
      { value: 'onStart', label: 'After start' },
      { value: 'onPause', label: 'After pause' },
      { value: 'onStop', label: 'After stop' },
      { value: 'onEnd', label: 'After it ends on its own' },
    ],
    proxy: [
      { value: 'onStart', label: 'After start' },
      { value: 'onPause', label: 'After pause' },
      { value: 'onStop', label: 'After stop' },
      { value: 'onEnd', label: 'After it ends on its own' },
    ],
    timer: [
      { value: 'onStart', label: 'After it runs' },
      { value: 'onStop', label: 'After it runs out' },
    ],
    http: [{ value: 'onStart', label: 'After it fires' }],
  };

  interface ActionOption {
    value: TriggerAction;
    label: string;
    fadeable?: boolean;
  }

  const AUDIO_ACTIONS: ActionOption[] = [
    { value: 'click', label: 'Click (toggle)' },
    { value: 'start', label: 'Start', fadeable: true },
    { value: 'pause', label: 'Pause', fadeable: true },
    { value: 'resume', label: 'Resume', fadeable: true },
    { value: 'stop', label: 'Stop', fadeable: true },
  ];
  const TIMER_ACTIONS: ActionOption[] = [
    { value: 'click', label: "Click (its own action)" },
    { value: 'set', label: 'Set & start' },
    { value: 'pause', label: 'Pause' },
    { value: 'resume', label: 'Resume' },
    { value: 'clear', label: 'Clear' },
  ];
  const HTTP_ACTIONS: ActionOption[] = [{ value: 'click', label: 'Fire request' }];
  const FALLBACK_ACTIONS: ActionOption[] = [{ value: 'click', label: 'Click' }];

  function actionsFor(target: CueRef): ActionOption[] {
    const targetCue = app.resolveRef(target);
    const effective = targetCue ? app.resolveProxy(targetCue) : null;
    if (effective?.type === 'audio') return AUDIO_ACTIONS;
    if (effective?.type === 'timer') return TIMER_ACTIONS;
    if (effective?.type === 'http') return HTTP_ACTIONS;
    return FALLBACK_ACTIONS;
  }

  function addTrigger() {
    cue.triggers.push({
      event: EVENTS_BY_TYPE[cue.type][0].value,
      target: { cueId: '' },
      action: 'click',
    });
    app.markDirty();
  }

  function remove(i: number) {
    cue.triggers.splice(i, 1);
    app.markDirty();
  }

  function setFade(trig: Trigger, checked: boolean) {
    trig.fade = checked;
    app.markDirty();
  }
</script>

<div class="triggers">
  <div class="row head">
    <label>Triggers</label>
    <button class="ghost" onclick={addTrigger}>+ Add</button>
  </div>

  {#each cue.triggers as trig, i (i)}
    {@const actions = actionsFor(trig.target)}
    {@const fadeable = actions.find((o) => o.value === trig.action)?.fadeable}
    <div class="trig">
      <div class="line">
        <select bind:value={trig.event} onchange={() => app.markDirty()}>
          {#each EVENTS_BY_TYPE[cue.type] as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
        <select bind:value={trig.action} onchange={() => app.markDirty()}>
          {#each actions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
        <button class="x" title="Remove" onclick={() => remove(i)}>×</button>
      </div>
      {#if fadeable}
        <label class="check">
          <input
            type="checkbox"
            checked={trig.fade ?? false}
            onchange={(e) => setFade(trig, e.currentTarget.checked)}
          /> Fade
        </label>
      {/if}
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
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
    font-size: 13px;
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
