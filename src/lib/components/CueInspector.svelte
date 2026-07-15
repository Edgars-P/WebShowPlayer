<script lang="ts">
  import { app } from '../state/project.svelte';
  import type {
    AudioCue,
    HttpCue,
    HttpMethod,
    ProxyCue,
    StopBehavior,
    TimerAction,
    TimerCue,
  } from '../types';
  import TriggerEditor from './TriggerEditor.svelte';

  let cue = $derived(app.propertiesCue);
  let tabs = $derived(app.project?.tabs ?? []);

  function close() {
    app.closeProperties();
  }

  function onFileChange(c: AudioCue, file: string) {
    c.file = file;
    app.markDirty();
    void app.reloadCueAudio(c);
  }

  // endTime is nullable; edit through a text field.
  function endTimeStr(c: AudioCue): string {
    return c.endTime == null ? '' : String(c.endTime);
  }
  function setEndTime(c: AudioCue, v: string) {
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
    onclick={close}
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
  >
    <div class="dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <header>
        <h3>{cue.type.toUpperCase()} cue — row {cue.row}, col {cue.col}</h3>
        <button class="close" title="Close" onclick={close}>×</button>
      </header>

      <div class="content">
        {#if cue.type === 'audio'}
          {@const c = cue as AudioCue}
          <div class="field">
            <label>Name</label>
            <input bind:value={c.name} oninput={() => app.markDirty()} placeholder="(unnamed)" />
          </div>
          <div class="field">
            <label>File</label>
            <select value={c.file} onchange={(e) => onFileChange(c, e.currentTarget.value)}>
              <option value="">— none —</option>
              {#each app.audioFiles as f (f)}
                <option value={f}>{f}</option>
              {/each}
            </select>
            {#if c.file && !app.hasBuffer(c.id)}<span class="warn">not loaded</span>{/if}
          </div>
          <div class="field">
            <label>Colour</label>
            <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
          </div>
          <div class="grid2">
            <div class="field">
              <label>Start (s)</label>
              <input type="number" min="0" step="0.1" bind:value={c.startTime} oninput={() => app.markDirty()} />
            </div>
            <div class="field">
              <label>End (s, blank = end)</label>
              <input value={endTimeStr(c)} oninput={(e) => setEndTime(c, e.currentTarget.value)} />
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Fade in (s)</label>
              <input type="number" min="0" step="0.1" bind:value={c.fadeIn} oninput={() => app.markDirty()} />
            </div>
            <div class="field">
              <label>Fade out (s)</label>
              <input type="number" min="0" step="0.1" bind:value={c.fadeOut} oninput={() => app.markDirty()} />
            </div>
          </div>
          <div class="field">
            <label>Volume: {Math.round(c.volume * 100)}%</label>
            <input type="range" min="0" max="1" step="0.01" bind:value={c.volume} oninput={() => app.markDirty()} />
          </div>
          <div class="grid2">
            <label class="check">
              <input type="checkbox" bind:checked={c.loop} onchange={() => app.markDirty()} /> Loop
            </label>
            <div class="field">
              <label>On stop</label>
              <select bind:value={c.onStopBehavior} onchange={() => app.markDirty()}>
                <option value={'stop' as StopBehavior}>Stop (reset)</option>
                <option value={'pause' as StopBehavior}>Pause (resume)</option>
              </select>
            </div>
          </div>
        {:else if cue.type === 'proxy'}
          {@const c = cue as ProxyCue}
          <p class="hint">Mirrors another cue and controls the same instance.</p>
          <div class="field">
            <label>Source tab</label>
            <select bind:value={c.source.tab} onchange={() => app.markDirty()}>
              {#each tabs as t (t.id)}
                <option value={t.id}>{t.name}</option>
              {/each}
            </select>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Source row</label>
              <input type="number" min="0" bind:value={c.source.row} onchange={() => app.markDirty()} />
            </div>
            <div class="field">
              <label>Source col</label>
              <input type="number" min="0" bind:value={c.source.col} onchange={() => app.markDirty()} />
            </div>
          </div>
          <div class="hint">→ {app.display(c).missing ? 'unresolved' : app.display(c).name}</div>
        {:else if cue.type === 'timer'}
          {@const c = cue as TimerCue}
          <p class="hint">Controls the single global timer slot.</p>
          <div class="field">
            <label>Name</label>
            <input bind:value={c.name} oninput={() => app.markDirty()} placeholder="(unnamed)" />
          </div>
          <div class="field">
            <label>Colour</label>
            <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
          </div>
          <div class="field">
            <label>Action</label>
            <select bind:value={c.action} onchange={() => app.markDirty()}>
              <option value={'set' as TimerAction}>Set &amp; start</option>
              <option value={'pause' as TimerAction}>Pause</option>
              <option value={'resume' as TimerAction}>Resume</option>
              <option value={'clear' as TimerAction}>Clear</option>
            </select>
          </div>
          {#if c.action === 'set'}
            <div class="field">
              <label>Duration (s)</label>
              <input type="number" min="0" step="1" bind:value={c.duration} oninput={() => app.markDirty()} />
            </div>
          {/if}
        {:else if cue.type === 'http'}
          {@const c = cue as HttpCue}
          <div class="field">
            <label>Name</label>
            <input bind:value={c.name} oninput={() => app.markDirty()} />
          </div>
          <div class="field">
            <label>Colour</label>
            <input type="color" bind:value={c.color} oninput={() => app.markDirty()} />
          </div>
          <div class="grid2">
            <div class="field">
              <label>Method</label>
              <select bind:value={c.method} onchange={() => app.markDirty()}>
                {#each ['GET', 'POST', 'PUT', 'DELETE'] as m}
                  <option value={m as HttpMethod}>{m}</option>
                {/each}
              </select>
            </div>
            <div class="field">
              <label>URL</label>
              <input bind:value={c.url} oninput={() => app.markDirty()} placeholder="http://…" />
            </div>
          </div>
          <div class="field">
            <label>Headers</label>
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
                  >×</button
                >
              </div>
            {/each}
            <button class="ghost small" onclick={() => setHeaders(c, [...headerRows(c), ['', '']])}
              >+ header</button
            >
          </div>
          {#if c.method !== 'GET'}
            <div class="field">
              <label>Body</label>
              <textarea rows="3" bind:value={c.body} oninput={() => app.markDirty()}></textarea>
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
  .field > input,
  .field > select,
  .field > textarea {
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
