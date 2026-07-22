<script lang="ts">
  import { app } from '../state/project.svelte';
  import type {
    AudioCue,
    GlobalAction,
    GlobalCue,
    GlobalScope,
    HttpCue,
    HttpMethod,
    ProxyCue,
    StopBehavior,
    TimerAction,
    TimerCue,
    VideoAction,
    VideoCue,
    VideoFit,
  } from '../types';
  import CuePicker from './CuePicker.svelte';
  import TriggerEditor from './TriggerEditor.svelte';
  import IconClose from '~icons/bi/x-lg';
  import IconRemove from '~icons/bi/x';

  let cue = $derived(app.propertiesCue);

  function close() {
    app.closeProperties();
  }

  // Only close on a genuine click on the overlay itself; a mousedown inside
  // the dialog that drags (e.g. text selection) out over the overlay would
  // otherwise fire a "click" on the overlay too.
  let overlayMouseDown = false;
  function onOverlayMouseDown(e: MouseEvent) {
    overlayMouseDown = e.target === e.currentTarget;
  }
  function onOverlayClick(e: MouseEvent) {
    if (overlayMouseDown && e.target === e.currentTarget) close();
    overlayMouseDown = false;
  }

  function onFileChange(c: AudioCue, file: string) {
    c.file = file;
    app.markDirty();
    void app.reloadCueAudio(c);
  }

  // endTime is nullable; edit through a text field. Shared by audio and video
  // cues, which trim the same way.
  function endTimeStr(c: { endTime: number | null }): string {
    return c.endTime == null ? '' : String(c.endTime);
  }
  function setEndTime(c: { endTime: number | null }, v: string) {
    const n = parseFloat(v);
    c.endTime = v.trim() === '' || Number.isNaN(n) ? null : n;
    app.markDirty();
  }

  // Headers as editable key/value rows.
  function headerRows(c: HttpCue): [string, string][] {
    return Object.entries(c.headers);
  }
  function setHeaders(c: HttpCue, rows: [string, string][]) {
    const obj: Record<string, string> = {};
    for (const [k, v] of rows) if (k.trim()) obj[k] = v;
    c.headers = obj;
    app.markDirty();
  }
</script>

{#if cue}
  <div
    class="overlay"
    onmousedown={onOverlayMouseDown}
    onclick={onOverlayClick}
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
  >
    <div class="dialog" role="dialog" aria-modal="true">
      <header>
        <h3>{cue.type.toUpperCase()} cue — row {cue.row}, col {cue.col}</h3>
        <button class="close" title="Close" onclick={close}><IconClose /></button>
      </header>

      <div class="content">
        {#if cue.type === 'audio'}
          {@const c = cue as AudioCue}
          <div class="field">
            <label>
              Name
              <input bind:value={c.name} oninput={() => app.markDirty()} placeholder="(unnamed)" />
            </label>
          </div>
          <div class="field">
            <label>
              File
              <select value={c.file} onchange={(e) => onFileChange(c, e.currentTarget.value)}>
                <option value="">— none —</option>
                {#each app.audioFiles as f (f)}
                  <option value={f}>{f}</option>
                {/each}
              </select>
            </label>
            {#if c.file && !app.hasBuffer(c.id)}<span class="warn">not loaded</span>{/if}
          </div>
          <div class="field">
            <label>
              Colour
              <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
            </label>
          </div>
          <div class="grid2">
            <div class="field">
              <label>
                Start (s)
                <input type="number" min="0" step="0.1" bind:value={c.startTime} oninput={() => app.markDirty()} />
              </label>
            </div>
            <div class="field">
              <label>
                End (s, blank = end)
                <input value={endTimeStr(c)} oninput={(e) => setEndTime(c, e.currentTarget.value)} />
              </label>
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label>
                Fade in (s)
                <input type="number" min="0" step="0.1" bind:value={c.fadeIn} oninput={() => app.markDirty()} />
              </label>
            </div>
            <div class="field">
              <label>
                Fade out (s)
                <input type="number" min="0" step="0.1" bind:value={c.fadeOut} oninput={() => app.markDirty()} />
              </label>
            </div>
          </div>
          <label class="check">
            <input
              type="checkbox"
              checked={c.fadeOutOnEnd ?? false}
              disabled={c.loop || c.fadeOut <= 0}
              onchange={(e) => {
                c.fadeOutOnEnd = e.currentTarget.checked;
                app.markDirty();
              }}
            />
            Fade out at end too
          </label>
          <div class="field">
            <label>
              Volume: {Math.round(c.volume * 100)}%
              <input type="range" min="0" max="2" step="0.01" bind:value={c.volume} oninput={() => app.markDirty()} />
            </label>
          </div>
          <div class="grid2">
            <label class="check">
              <input type="checkbox" bind:checked={c.loop} onchange={() => app.markDirty()} /> Loop
            </label>
            <div class="field">
              <label>
                On stop
                <select bind:value={c.onStopBehavior} onchange={() => app.markDirty()}>
                  <option value={'stop' as StopBehavior}>Stop (reset)</option>
                  <option value={'pause' as StopBehavior}>Pause (resume)</option>
                </select>
              </label>
            </div>
          </div>
        {:else if cue.type === 'proxy'}
          {@const c = cue as ProxyCue}
          <div class="field">
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label>Source</label>
            <CuePicker target={c.source} />
          </div>
        {:else if cue.type === 'timer'}
          {@const c = cue as TimerCue}
          <div class="field">
            <label>
              Name
              <input bind:value={c.name} oninput={() => app.markDirty()} placeholder="(unnamed)" />
            </label>
          </div>
          <div class="field">
            <label>
              Colour
              <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
            </label>
          </div>
          <div class="field">
            <label>
              Action
              <select bind:value={c.action} onchange={() => app.markDirty()}>
                <option value={'set' as TimerAction}>Set &amp; start</option>
                <option value={'pause' as TimerAction}>Pause</option>
                <option value={'resume' as TimerAction}>Resume</option>
                <option value={'clear' as TimerAction}>Clear</option>
              </select>
            </label>
          </div>
          {#if c.action === 'set'}
            <div class="field">
              <label>
                Duration (s)
                <input type="number" min="0" step="1" bind:value={c.duration} oninput={() => app.markDirty()} />
              </label>
            </div>
          {/if}
        {:else if cue.type === 'video'}
          {@const c = cue as VideoCue}
          <div class="field">
            <label>
              Name
              <input bind:value={c.name} oninput={() => app.markDirty()} placeholder="(unnamed)" />
            </label>
          </div>
          <div class="field">
            <label>
              Colour
              <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
            </label>
          </div>
          <div class="field">
            <label>
              Action
              <select bind:value={c.action} onchange={() => app.markDirty()}>
                <option value={'play' as VideoAction}>Play clip</option>
                <option value={'pause' as VideoAction}>Pause</option>
                <option value={'resume' as VideoAction}>Resume</option>
                <option value={'clear' as VideoAction}>Clear screen</option>
              </select>
            </label>
          </div>
          {#if c.action === 'play'}
            <div class="field">
              <label>
                Clip
                <select bind:value={c.file} onchange={() => app.markDirty()}>
                  <option value="">— none —</option>
                  {#each app.videoFiles as f (f)}
                    <option value={f}>{f}</option>
                  {/each}
                </select>
              </label>
              {#if app.videoFiles.length === 0}
                <span class="hint">No video files in this project folder.</span>
              {/if}
            </div>
            <div class="grid2">
              <div class="field">
                <label>
                  Start (s)
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={c.startTime ?? 0}
                    oninput={(e) => {
                      c.startTime = parseFloat(e.currentTarget.value) || 0;
                      app.markDirty();
                    }}
                  />
                </label>
              </div>
              <div class="field">
                <label>
                  End (s, blank = end)
                  <input value={endTimeStr(c)} oninput={(e) => setEndTime(c, e.currentTarget.value)} />
                </label>
              </div>
            </div>
            <div class="grid2">
              <div class="field">
                <label>
                  Fade in (s)
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={c.fadeIn ?? 0}
                    oninput={(e) => {
                      c.fadeIn = parseFloat(e.currentTarget.value) || 0;
                      app.markDirty();
                    }}
                  />
                </label>
              </div>
              <div class="field">
                <label>
                  Fade out (s)
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={c.fadeOut ?? 0}
                    oninput={(e) => {
                      c.fadeOut = parseFloat(e.currentTarget.value) || 0;
                      app.markDirty();
                    }}
                  />
                </label>
              </div>
            </div>
            <label class="check">
              <input
                type="checkbox"
                checked={c.fadeOutOnEnd ?? false}
                disabled={c.loop || (c.fadeOut ?? 0) <= 0}
                onchange={(e) => {
                  c.fadeOutOnEnd = e.currentTarget.checked;
                  app.markDirty();
                }}
              />
              Fade out at end too
            </label>
            <div class="grid2">
              <label class="check">
                <input type="checkbox" bind:checked={c.loop} onchange={() => app.markDirty()} /> Loop
              </label>
              <div class="field">
                <label>
                  Fit
                  <select bind:value={c.fit} onchange={() => app.markDirty()}>
                    <option value={'contain' as VideoFit}>Fit (letterbox)</option>
                    <option value={'cover' as VideoFit}>Fill (crop)</option>
                  </select>
                </label>
              </div>
            </div>
            <div class="field">
              <label>
                On click while it's up
                <select bind:value={c.onStopBehavior} onchange={() => app.markDirty()}>
                  <option value={'stop' as StopBehavior}>Clear the screen</option>
                  <option value={'pause' as StopBehavior}>Hold the frame (click to resume)</option>
                </select>
              </label>
            </div>
            <div class="field">
              <label>
                Volume: {c.muted ? 'muted' : `${Math.round(c.volume * 100)}%`}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  disabled={c.muted}
                  bind:value={c.volume}
                  oninput={() => app.markDirty()}
                />
              </label>
            </div>
            <label class="check">
              <input type="checkbox" bind:checked={c.muted} onchange={() => app.markDirty()} /> Mute
            </label>
            {#if !app.screenLive}
              <span class="warn">
                No screen window is open, so video cues do nothing at all — not even their triggers.
                Open it from the toolbar.
              </span>
            {/if}
          {/if}
        {:else if cue.type === 'global'}
          {@const c = cue as GlobalCue}
          <div class="field">
            <label>
              Name
              <input bind:value={c.name} oninput={() => app.markDirty()} placeholder="(unnamed)" />
            </label>
          </div>
          <div class="field">
            <label>
              Colour
              <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
            </label>
          </div>
          <div class="field">
            <label>
              Action
              <select bind:value={c.action} onchange={() => app.markDirty()}>
                <option value={'stop' as GlobalAction}>Stop all</option>
                <option value={'pause' as GlobalAction}>Pause all</option>
                <option value={'resume' as GlobalAction}>Resume all</option>
              </select>
            </label>
          </div>
          <div class="field">
            <label>
              Scope
              <select bind:value={c.scope} onchange={() => app.markDirty()}>
                <option value={'document' as GlobalScope}>This cue file</option>
                <option value={'all' as GlobalScope}>Every open cue file</option>
              </select>
            </label>
          </div>
          <label class="check">
            <input type="checkbox" bind:checked={c.fade} onchange={() => app.markDirty()} />
            Use each cue's own fade
          </label>
        {:else if cue.type === 'http'}
          {@const c = cue as HttpCue}
          <div class="field">
            <label>
              Name
              <input bind:value={c.name} oninput={() => app.markDirty()} />
            </label>
          </div>
          <div class="field">
            <label>
              Colour
              <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
            </label>
          </div>
          <div class="grid2">
            <div class="field">
              <label>
                Method
                <select bind:value={c.method} onchange={() => app.markDirty()}>
                  {#each ['GET', 'POST', 'PUT', 'DELETE'] as m}
                    <option value={m as HttpMethod}>{m}</option>
                  {/each}
                </select>
              </label>
            </div>
            <div class="field">
              <label>
                URL
                <input bind:value={c.url} oninput={() => app.markDirty()} placeholder="http://…" />
              </label>
            </div>
          </div>
          <div class="field">
            <span class="label-text">Headers</span>
            {#each headerRows(c) as [k, v], i (i)}
              <div class="hrow">
                <input
                  value={k}
                  placeholder="Header"
                  oninput={(e) => {
                    const rows = headerRows(c);
                    rows[i] = [e.currentTarget.value, v];
                    setHeaders(c, rows);
                  }}
                />
                <input
                  value={v}
                  placeholder="Value"
                  oninput={(e) => {
                    const rows = headerRows(c);
                    rows[i] = [k, e.currentTarget.value];
                    setHeaders(c, rows);
                  }}
                />
                <button class="x" onclick={() => setHeaders(c, headerRows(c).filter((_, j) => j !== i))}
                  ><IconRemove /></button
                >
              </div>
            {/each}
            <button class="ghost small" onclick={() => setHeaders(c, [...headerRows(c), ['', '']])}
              >+ header</button
            >
          </div>
          {#if c.method !== 'GET'}
            <div class="field">
              <label>
                Body
                <textarea rows="3" bind:value={c.body} oninput={() => app.markDirty()}></textarea>
              </label>
            </div>
          {/if}
        {/if}

        <hr />
        <TriggerEditor {cue} />
      </div>

      <footer>
        <button class="danger" onclick={() => app.removeCue(cue.id)}>Delete cue</button>
        <button class="primary" onclick={close}>Done</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .dialog {
    width: 380px;
    max-width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  header h3 {
    font-size: 14px;
  }
  .close {
    border: none;
    background: transparent;
    font-size: 20px;
    line-height: 1;
    color: var(--muted);
    padding: 0 6px;
  }
  .close:hover {
    color: var(--text);
  }
  .content {
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  footer {
    display: flex;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field > label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field input,
  .field select,
  .field textarea {
    width: 100%;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    align-items: end;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
  }
  .label-text {
    color: var(--text);
  }
  .hrow {
    display: flex;
    gap: 4px;
    margin-bottom: 4px;
  }
  .hrow input {
    flex: 1;
    min-width: 0;
  }
  .x {
    border: none;
    background: transparent;
    color: var(--muted);
  }
  .x:hover {
    color: var(--danger);
  }
  .small {
    font-size: 12px;
    padding: 3px 8px;
  }
  .hint {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .warn {
    color: var(--warn);
    font-size: 11px;
  }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 4px 0;
  }
</style>
