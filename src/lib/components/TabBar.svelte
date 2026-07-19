<script lang="ts">
  import { app, type MenuItem } from '../state/project.svelte';

  let project = $derived(app.project);
  let editingId = $state<string | null>(null);
  /** Tab currently being dragged over, for the drop highlight. */
  let dropId = $state<string | null>(null);

  const CUE = 'text/cue-id';
  const TAB = 'text/tab-id';

  const carries = (e: DragEvent, type: string) =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(type);

  function onTabDragStart(e: DragEvent, id: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(TAB, id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onTabDragOver(e: DragEvent, id: string) {
    // Tabs accept a tab being reordered, or a cue being moved into them.
    if (!carries(e, TAB) && !carries(e, CUE)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dropId = id;
  }

  function onTabDrop(e: DragEvent, id: string, index: number) {
    e.preventDefault();
    dropId = null;
    const tabId = e.dataTransfer?.getData(TAB);
    if (tabId) {
      app.moveTab(tabId, index);
      return;
    }
    const cueId = e.dataTransfer?.getData(CUE);
    if (cueId) app.moveCueToTab(cueId, id);
  }

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
  <div class="tabbar" ondragleave={() => (dropId = null)} role="tablist" tabindex="-1">
    {#each project.tabs as tab, i (tab.id)}
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
          class:dropping={dropId === tab.id}
          draggable="true"
          ondragstart={(e) => onTabDragStart(e, tab.id)}
          ondragend={() => (dropId = null)}
          ondragover={(e) => onTabDragOver(e, tab.id)}
          ondrop={(e) => onTabDrop(e, tab.id, i)}
          onclick={() => (app.activeTabId = tab.id)}
          ondblclick={() => (editingId = tab.id)}
          oncontextmenu={(e) => onTabContext(e, tab.id)}
          title="Drag to reorder, or drop a cue here to move it to this tab"
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
  .tabbtn:active {
    cursor: grabbing;
  }
  /* Drop target for a reordered tab or an incoming cue. */
  .tabbtn.dropping {
    border-color: var(--accent);
    background: rgba(59, 130, 246, 0.25);
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
