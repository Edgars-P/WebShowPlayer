<script lang="ts">
  // Top-level tab strip: one tab per open cue file. The strip below it (TabBar)
  // switches between tabs *within* the active file.
  import { app, type MenuItem } from '../state/project.svelte';

  function onDocContext(e: MouseEvent, id: string) {
    e.preventDefault();
    const items: MenuItem[] = [];
    if (app.docs.length > 1) {
      items.push({
        label: 'Close others',
        action: () => {
          for (const other of [...app.docs]) if (other.id !== id) app.closeDoc(other.id);
        },
      });
    }
    items.push({ label: 'Close', danger: true, action: () => app.closeDoc(id) });
    app.openMenu(e.clientX, e.clientY, items);
  }
</script>

<div class="docbar">
  {#each app.docs as doc (doc.id)}
    <div class="doctab" class:active={doc.id === app.activeDocId}>
      <button
        class="pick"
        title={`${doc.folder.name}/${doc.title}`}
        onclick={() => app.selectDoc(doc.id)}
        oncontextmenu={(e) => onDocContext(e, doc.id)}
      >
        {#if doc.loading}
          <span class="spin" aria-hidden="true"></span>
        {:else if doc.dirty}
          <span class="dot" title="Unsaved changes" aria-hidden="true"></span>
        {/if}
        <span class="title">{doc.title}</span>
      </button>
      <button class="close" title="Close" onclick={() => app.closeDoc(doc.id)}>×</button>
    </div>
  {/each}
  <button class="add" title="Open or create another cue file" onclick={() => app.showChooser()}>+</button>
  <button class="add folder" title="Open another folder…" onclick={() => app.openFolder()}>📁</button>
</div>

<style>
  .docbar {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 8px 0;
    background: var(--bg, #14161a);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .doctab {
    display: flex;
    align-items: center;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    padding-right: 2px;
    max-width: 220px;
  }
  .doctab.active {
    background: var(--panel);
    border-color: var(--accent);
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 7px 4px 7px 10px;
    min-width: 0;
    color: var(--muted);
  }
  .doctab.active .pick {
    color: inherit;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn, #f59e0b);
    flex: none;
  }
  .spin {
    width: 9px;
    height: 9px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    flex: none;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .close {
    background: transparent;
    border: none;
    color: var(--muted);
    padding: 2px 6px;
    font-size: 15px;
    line-height: 1;
  }
  .close:hover {
    color: var(--danger, #ef4444);
  }
  .add {
    background: transparent;
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    color: var(--muted);
    padding: 6px 10px;
    margin-left: 2px;
  }
  .add.folder {
    font-size: 12px;
  }
</style>
