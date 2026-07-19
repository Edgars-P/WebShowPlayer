<script lang="ts">
  import { app } from './lib/state/project.svelte';
  import FolderPrompt from './lib/components/FolderPrompt.svelte';
  import Toolbar from './lib/components/Toolbar.svelte';
  import DocBar from './lib/components/DocBar.svelte';
  import TabBar from './lib/components/TabBar.svelte';
  import Launchpad from './lib/components/Launchpad.svelte';
  import CueInspector from './lib/components/CueInspector.svelte';
  import ContextMenu from './lib/components/ContextMenu.svelte';
  import CueFileChooser from './lib/components/CueFileChooser.svelte';
  import NewFilePrompt from './lib/components/NewFilePrompt.svelte';
  import TrelloSidebar from './lib/components/TrelloSidebar.svelte';

  // Once anything is open the shell stays up; the chooser becomes an overlay so
  // opening a second cue file never tears down the documents already loaded.
  let showApp = $derived(app.docs.length > 0);

  // Warn before leaving with unsaved changes in any open document.
  function beforeUnload(e: BeforeUnloadEvent) {
    if (app.anyDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#if !showApp}
  {#if app.status === 'choosing'}
    <CueFileChooser />
  {:else}
    <FolderPrompt />
  {/if}
{:else}
  <div class="app">
    <DocBar />
    <Toolbar />
    <TabBar />
    <div class="body">
      <main class="stage">
        <Launchpad />
      </main>
      <TrelloSidebar />
    </div>
    {#if app.errorMessage}
      <div class="errbar">{app.errorMessage} <button class="ghost" onclick={() => (app.errorMessage = '')}>dismiss</button></div>
    {/if}
  </div>

  {#if app.status === 'choosing'}
    <div class="overlay">
      <CueFileChooser />
    </div>
  {/if}

  <CueInspector />
  <ContextMenu />
{/if}

<!-- Sits above both the shell and the chooser: naming a new file can be reached
     from either, including from the empty state before anything is open. -->
{#if app.newFileFolder}
  <NewFilePrompt />
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
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.6);
    overflow: auto;
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
