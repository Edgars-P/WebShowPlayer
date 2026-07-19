<script lang="ts">
  import { app } from '../state/project.svelte';

  function ext(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toUpperCase() : '';
  }

  /** Files already open as a document tab — picking one just switches to it. */
  let open = $derived(new Set(app.docs.map((d) => d.currentFileName).filter(Boolean)));
</script>

<div class="chooser">
  <div class="card">
    <h1>Choose a cue file</h1>
    {#if app.cueFiles.length === 0}
      <p class="sub">This folder has no cue files yet — create one to get started.</p>
    {:else}
      <p class="sub">Pick one to open in a new tab. Several can be open at once.</p>
    {/if}

    <ul class="list">
      {#each app.cueFiles as name (name)}
        <li>
          <button class="item" onclick={() => app.openCueFile(name)}>
            <span class="name">{name}</span>
            <span class="tags">
              {#if open.has(name)}<span class="badge open">OPEN</span>{/if}
              <span class="badge" class:lsp={ext(name) === 'LSP'}>{ext(name)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>

    <div class="actions">
      <button class="ghost" onclick={() => app.promptNewCueFile()}>New cue file…</button>
      <button class="ghost" onclick={() => app.openFolder()}>Open another folder…</button>
      {#if app.docs.length > 0}
        <button class="ghost" onclick={() => app.cancelChooser()}>Cancel</button>
      {/if}
    </div>
    <p class="hint">.lsp files (Linux Show Player) are converted on open and saved as .wsp.</p>
  </div>
</div>

<style>
  .chooser {
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px;
    width: 460px;
    max-width: 100%;
  }
  h1 {
    font-size: 22px;
  }
  .sub {
    color: var(--muted);
  }
  .list {
    list-style: none;
    margin: 16px 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 46vh;
    overflow-y: auto;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: var(--panel-2);
  }
  .item:hover {
    border-color: var(--accent);
  }
  .name {
    font-weight: 600;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .badge.lsp {
    color: var(--warn);
    border-color: var(--warn);
  }
  .tags {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .badge.open {
    color: var(--accent);
    border-color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 0;
  }
</style>
