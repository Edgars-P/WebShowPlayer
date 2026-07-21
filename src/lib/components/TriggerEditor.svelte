<script lang="ts">
  import { app } from '../state/project.svelte';
  import type { Cue, CueRef, Trigger, TriggerAction, TriggerEvent } from '../types';
  import CuePicker from './CuePicker.svelte';
  import IconPlayFill from '~icons/bi/play-fill';
  import IconPauseFill from '~icons/bi/pause-fill';
  import IconStopFill from '~icons/bi/stop-fill';
  import IconSkipEnd from '~icons/bi/skip-end-fill';
  import IconRemove from '~icons/bi/x';
  import type { Component } from 'svelte';

  let { cue }: { cue: Cue } = $props();

  // Every event this cue type can fire a trigger from, in lifecycle order.
  // Glyphs match the hover-hint badges (CueHints.svelte) so the vocabulary is
  // the same wherever a trigger shows up; the label is what differs, since
  // e.g. a timer's "onStop" means it ran out, not that something stopped it.
  const EVENTS_BY_TYPE: Record<Cue['type'], TriggerEvent[]> = {
    audio: ['onStart', 'onPause', 'onStop', 'onEnd'],
    proxy: ['onStart', 'onPause', 'onStop', 'onEnd'],
    timer: ['onStart', 'onStop'],
    video: ['onStart', 'onEnd'],
    http: ['onStart'],
    global: ['onStart'],
  };
  const EVENT_GLYPH: Record<TriggerEvent, Component> = {
    onStart: IconPlayFill,
    onPause: IconPauseFill,
    onStop: IconStopFill,
    onEnd: IconSkipEnd,
  };
  const EVENT_LABEL: Record<Cue['type'], Partial<Record<TriggerEvent, string>>> = {
    audio: { onStart: 'Start', onPause: 'Pause', onStop: 'Stop', onEnd: 'Ends on its own' },
    proxy: { onStart: 'Start', onPause: 'Pause', onStop: 'Stop', onEnd: 'Ends on its own' },
    timer: { onStart: 'Starts', onStop: 'Runs out' },
    video: { onStart: 'Starts', onEnd: 'Ends on its own' },
    http: { onStart: 'Fires' },
    global: { onStart: 'Runs' },
  };

  interface ActionOption {
    value: TriggerAction;
    label: string;
    fadeable?: boolean;
  }

  const AUDIO_ACTIONS: ActionOption[] = [
    { value: 'click', label: 'Toggle' },
    { value: 'start', label: 'Start', fadeable: true },
    { value: 'pause', label: 'Pause', fadeable: true },
    { value: 'resume', label: 'Resume', fadeable: true },
    { value: 'stop', label: 'Stop', fadeable: true },
  ];
  const TIMER_ACTIONS: ActionOption[] = [
    { value: 'click', label: 'Run' },
    { value: 'set', label: 'Set & start' },
    { value: 'pause', label: 'Pause' },
    { value: 'resume', label: 'Resume' },
    { value: 'clear', label: 'Clear' },
  ];
  const VIDEO_ACTIONS: ActionOption[] = [
    { value: 'click', label: 'Run' },
    { value: 'start', label: 'Play' },
    { value: 'pause', label: 'Pause' },
    { value: 'resume', label: 'Resume' },
    { value: 'clear', label: 'Clear screen' },
  ];
  const HTTP_ACTIONS: ActionOption[] = [{ value: 'click', label: 'Fire' }];
  // A global cue carries its own action and scope, so a trigger just runs it.
  const GLOBAL_ACTIONS: ActionOption[] = [{ value: 'click', label: 'Run' }];
  const FALLBACK_ACTIONS: ActionOption[] = [{ value: 'click', label: 'Click' }];

  function actionsFor(target: CueRef): ActionOption[] {
    const targetCue = app.resolveRef(target);
    const effective = targetCue ? app.resolveProxy(targetCue) : null;
    if (effective?.type === 'audio') return AUDIO_ACTIONS;
    if (effective?.type === 'timer') return TIMER_ACTIONS;
    if (effective?.type === 'video') return VIDEO_ACTIONS;
    if (effective?.type === 'http') return HTTP_ACTIONS;
    if (effective?.type === 'global') return GLOBAL_ACTIONS;
    return FALLBACK_ACTIONS;
  }

  function addTrigger() {
    cue.triggers.push({
      events: [EVENTS_BY_TYPE[cue.type][0]],
      target: { cueId: '' },
      action: 'click',
    });
    app.markDirty();
  }

  function remove(i: number) {
    cue.triggers.splice(i, 1);
    app.markDirty();
  }

  function toggleEvent(trig: Trigger, ev: TriggerEvent) {
    const pos = trig.events.indexOf(ev);
    if (pos >= 0) {
      // Always leave at least one event behind — turn off the last one with
      // the trash button instead, which removes the whole trigger on purpose.
      if (trig.events.length === 1) return;
      trig.events.splice(pos, 1);
    } else {
      trig.events.push(ev);
    }
    app.markDirty();
  }

  function setFade(trig: Trigger, checked: boolean) {
    trig.fade = checked;
    app.markDirty();
  }
</script>

<div class="triggers">
  <div class="row head">
    <span>Triggers</span>
    <button class="ghost" onclick={addTrigger}>+ Add</button>
  </div>

  {#each cue.triggers as trig, i (i)}
    {@const targetCue = app.resolveRef(trig.target)}
    {@const actions = actionsFor(trig.target)}
    {@const fadeable = actions.find((o) => o.value === trig.action)?.fadeable}
    <div class="trig">
      <div class="line events">
        {#if EVENTS_BY_TYPE[cue.type].length > 1}
          {#each EVENTS_BY_TYPE[cue.type] as ev (ev)}
            {@const Icon = EVENT_GLYPH[ev]}
            <button
              type="button"
              class="evt"
              class:active={trig.events.includes(ev)}
              title={EVENT_LABEL[cue.type][ev]}
              onclick={() => toggleEvent(trig, ev)}
            >
              <Icon />
            </button>
          {/each}
        {/if}
        <span class="spacer"></span>
        <button class="x" title="Remove" onclick={() => remove(i)}><IconRemove /></button>
      </div>
      <CuePicker target={trig.target} />
      {#if targetCue}
        <div class="line">
          <select bind:value={trig.action} onchange={() => app.markDirty()}>
            {#each actions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
          {#if fadeable}
            <label class="check">
              <input
                type="checkbox"
                checked={trig.fade ?? true}
                onchange={(e) => setFade(trig, e.currentTarget.checked)}
              /> Fade
            </label>
          {/if}
        </div>
      {/if}
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
  .events {
    gap: 4px;
  }
  .spacer {
    flex: 1;
  }
  .evt {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
  }
  .evt:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .evt.active {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
    font-size: 13px;
    white-space: nowrap;
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
