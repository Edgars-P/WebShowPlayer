<script lang="ts">
  import { app } from './lib/state/project.svelte';
  import FolderPrompt from './lib/components/FolderPrompt.svelte';
  import Toolbar from './lib/components/Toolbar.svelte';
  import TabBar from './lib/components/TabBar.svelte';
  import Launchpad from './lib/components/Launchpad.svelte';
  import CueInspector from './lib/components/CueInspector.svelte';
  import ContextMenu from './lib/components/ContextMenu.svelte';
  import CueFileChooser from './lib/components/CueFileChooser.svelte';

  let showApp = $derived(app.project != null && (app.status === 'ready' || app.status === 'error'));

  // Warn before leaving with unsaved changes.
  function beforeUnload(e: BeforeUnloadEvent) {
    if (app.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#if app.status === 'choosing'}
  <CueFileChooser />
{:else if !showApp}
  <FolderPrompt />
{:else}
  <div class="app">
    <Toolbar />
    <TabBar />
    <div class="body">
      <main class="stage">
        <Launchpad />
      </main>
    </div>
    {#if app.errorMessage}
      <div class="errbar">{app.errorMessage} <button class="ghost" onclick={() => (app.errorMessage = '')}>dismiss</button></div>
    {/if}
  </div>

  <CueInspector />
  <ContextMenu />
{/if}

<style>
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .stage {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .errbar {
    background: #3a1c1c;
    color: #ffd9d9;
    padding: 6px 12px;
    font-size: 13px;
    display: flex;
    gap: 10px;
    align-items: center;
  }
</style>
