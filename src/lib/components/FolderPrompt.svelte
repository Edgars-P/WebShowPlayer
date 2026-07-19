<script lang="ts">
  import { app } from '../state/project.svelte';
  import { isFsAccessSupported } from '../fs/projectFs';

  const supported = isFsAccessSupported();
</script>

<div class="prompt">
  <div class="card">
    <h1>Show Player</h1>
    <p class="sub">A launchpad-style audio cue player.</p>

    {#if !supported}
      <p class="err">
        Your browser doesn't support the File System Access API. Please use Chrome or Edge.
      </p>
    {:else}
      <p class="sub">
        Choose a project folder with your audio files (in subfolders is fine) and any cue files —
        <code>.wsp</code>, <code>.json</code>, or a <code>.lsp</code> to import.
      </p>
      <button class="primary big" onclick={() => app.openFolder()} disabled={app.status === 'loading'}>
        {app.status === 'loading' ? 'Loading…' : 'Open project folder'}
      </button>
      {#if app.status === 'loading' && app.progressView.total > 0}
        <p class="sub">Decoding audio {app.progressView.done}/{app.progressView.total}…</p>
      {/if}
    {/if}

    {#if app.errorMessage}
      <p class="err">{app.errorMessage}</p>
    {/if}
  </div>
</div>

<style>
  .prompt {
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    max-width: 460px;
    text-align: center;
  }
  h1 {
    font-size: 28px;
  }
  .sub {
    color: var(--muted);
    line-height: 1.5;
  }
  .big {
    font-size: 16px;
    padding: 12px 20px;
    margin-top: 8px;
  }
  .err {
    color: var(--danger);
  }
  code {
    background: var(--panel-2);
    padding: 1px 5px;
    border-radius: 4px;
  }
</style>
