<script lang="ts">
  // Names a new cue file before creating it. Shown by the explicit "New cue
  // file" action and when a folder is opened that has no cue files in it.
  import { app } from '../state/project.svelte';
  import { normalizeCueFileName } from '../fs/projectFs';

  let error = $derived(app.newFileError);
  let warning = $derived(app.newFileWarning);
  let resolved = $derived(normalizeCueFileName(app.newFileName));
  // Only worth previewing when it differs from what's typed (i.e. we appended
  // the extension for them).
  let showResolved = $derived(!error && resolved !== app.newFileName.trim());

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !error) app.createCueFile();
    else if (e.key === 'Escape') app.cancelNewCueFile();
  }
</script>

<div class="backdrop">
  <div class="card">
    <h1>New cue file</h1>

    <label class="field">
      <span class="lbl">Name</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        value={app.newFileName}
        oninput={(e) => (app.newFileName = e.currentTarget.value)}
        onkeydown={onKeydown}
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <p class="hint">
      {#if error}
        <span class="err">{error}</span>
      {:else if showResolved}
        Will be saved as <code>{resolved}</code> in <code>{app.newFileFolder?.name}/</code>
      {:else}
        Saved in <code>{app.newFileFolder?.name}/</code>
      {/if}
    </p>

    {#if warning}
      <p class="warn">{warning}</p>
    {/if}

    <div class="actions">
      <button class="ghost" onclick={() => app.cancelNewCueFile()}>Cancel</button>
      <button class="primary" disabled={!!error} onclick={() => app.createCueFile()}>Create</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.6);
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    width: 420px;
    max-width: 100%;
  }
  h1 {
    font-size: 20px;
    margin-top: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lbl {
    font-size: 12px;
    color: var(--muted);
  }
  .field input {
    width: 100%;
    padding: 9px 10px;
    font-size: 14px;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    margin: 8px 0 0;
    min-height: 16px;
  }
  .err {
    color: var(--danger);
  }
  .warn {
    color: var(--warn);
    font-size: 12px;
    margin: 8px 0 0;
  }
  code {
    background: var(--panel-2);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
</style>
