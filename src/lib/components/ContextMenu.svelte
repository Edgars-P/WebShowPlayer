<script lang="ts">
  import { app } from '../state/project.svelte';

  let menu = $derived(app.contextMenu);

  function run(action: () => void) {
    app.closeMenu();
    action();
  }
</script>

{#if menu}
  <!-- Backdrop closes the menu on any outside click / right-click. -->
  <div
    class="backdrop"
    onclick={() => app.closeMenu()}
    oncontextmenu={(e) => {
      e.preventDefault();
      app.closeMenu();
    }}
    role="presentation"
  ></div>
  <div class="menu" style:left={`${menu.x}px`} style:top={`${menu.y}px`} role="menu">
    {#each menu.items as item (item.label)}
      <button class="item" class:danger={item.danger} role="menuitem" onclick={() => run(item.action)}>
        {item.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: fixed;
    z-index: 41;
    min-width: 160px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
  }
  .item {
    background: transparent;
    border: none;
    text-align: left;
    padding: 7px 10px;
    border-radius: 5px;
    font-size: 13px;
  }
  .item:hover {
    background: var(--accent);
    color: white;
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger:hover {
    background: var(--danger);
    color: white;
  }
</style>
