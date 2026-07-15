<script lang="ts">
  import { app, type MenuItem } from '../state/project.svelte';

  let project = $derived(app.project);
  let editingId = $state<string | null>(null);

  function onTabContext(e: MouseEvent, id: string) {
    e.preventDefault();
    const items: MenuItem[] = [{ label: 'Rename', action: () => (editingId = id) }];
    if ((project?.tabs.length ?? 0) > 1) {
      items.push({ label: 'Delete tab', danger: true, action: () => app.removeTab(id) });
    }
    app.openMenu(e.clientX, e.clientY, items);
  }
</script>

{#if project}
  <div class="tabbar">
    {#each project.tabs as tab (tab.id)}
      {#if editingId === tab.id}
        <input
          class="tabname"
          value={tab.name}
          autofocus
          onblur={() => (editingId = null)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') editingId = null;
          }}
          oninput={(e) => app.renameTab(tab.id, e.currentTarget.value)}
        />
      {:else}
        <button
          class="tabbtn"
          class:active={tab.id === app.activeTabId}
          onclick={() => (app.activeTabId = tab.id)}
          ondblclick={() => (editingId = tab.id)}
          oncontextmenu={(e) => onTabContext(e, tab.id)}
        >
          {tab.name}
        </button>
      {/if}
    {/each}
    <button class="add" title="Add tab" onclick={() => app.addTab()}>+</button>
  </div>
{/if}

<style>
  .tabbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .tabbtn {
    background: var(--panel-2);
    border: 1px solid transparent;
    padding: 6px 12px;
    white-space: nowrap;
  }
  .tabbtn.active {
    border-color: var(--accent);
  }
  .add {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 6px 10px;
  }
  .tabname {
    width: 120px;
    padding: 5px 8px;
  }
</style>
