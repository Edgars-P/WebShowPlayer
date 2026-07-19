<script lang="ts">
  import { app, type MenuItem } from '../state/project.svelte';
  import { isAudioFile } from '../fs/projectFs';
  import CueButton from './CueButton.svelte';

  let project = $derived(app.project);
  let tab = $derived(app.activeTab);
  let hoverKey = $state<string | null>(null);

  function cells(rows: number, cols: number) {
    const out: { row: number; col: number }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ row: r, col: c });
    return out;
  }

  function dropHasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }

  // Tiles are only draggable while Shift or Ctrl is held, so an ordinary click
  // during a show can't nudge a cue out of place. `draggable` has to be set
  // before the drag starts, hence tracking the modifiers rather than checking
  // them in the handler.
  function syncModifiers(e: KeyboardEvent | MouseEvent) {
    app.dragModifier = e.shiftKey || e.ctrlKey;
  }
  function clearModifiers() {
    app.dragModifier = false;
  }

  async function onDrop(e: DragEvent, row: number, col: number) {
    e.preventDefault();
    hoverKey = null;
    const id = e.dataTransfer?.getData('text/cue-id');
    if (id) {
      if (e.ctrlKey) app.copyCue(id, row, col);
      else app.moveCue(id, row, col);
      return;
    }
    // External OS file drop: copy audio files in and add cues.
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => isAudioFile(f.name));
    if (files.length) await app.importAudioFiles(files, row, col);
  }

  function onDragOver(e: DragEvent, row: number, col: number) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = dropHasFiles(e) ? 'copy' : e.ctrlKey ? 'copy' : 'move';
    }
    hoverKey = `${row}-${col}`;
  }

  function onContext(e: MouseEvent, row: number, col: number) {
    e.preventDefault();
    if (!tab) return;
    const cue = app.cueAt(tab, row, col);
    let items: MenuItem[];
    if (cue) {
      items = [
        { label: 'Properties…', action: () => app.openProperties(cue.id) },
        { label: 'Delete cue', danger: true, action: () => app.removeCue(cue.id) },
      ];
    } else {
      items = [
        { label: 'Add audio cue', action: () => app.addNewCue('audio', row, col) },
        { label: 'Add proxy cue', action: () => app.addNewCue('proxy', row, col) },
        { label: 'Add timer cue', action: () => app.addNewCue('timer', row, col) },
        { label: 'Add global cue', action: () => app.addNewCue('global', row, col) },
        { label: 'Add HTTP cue', action: () => app.addNewCue('http', row, col) },
      ];
    }
    app.openMenu(e.clientX, e.clientY, items);
  }
</script>

<svelte:window
  onkeydown={syncModifiers}
  onkeyup={syncModifiers}
  onblur={clearModifiers}
/>

{#if project && tab}
  <div
    class="grid"
    class:dragready={app.dragModifier}
    style:grid-template-columns={`repeat(${project.grid.cols}, 1fr)`}
    style:grid-template-rows={`repeat(${project.grid.rows}, 1fr)`}
    ondragleave={() => (hoverKey = null)}
    onmouseleave={() => (app.hoveredCueId = null)}
    onmousemove={syncModifiers}
  >
    {#each cells(project.grid.rows, project.grid.cols) as cell (cell.row + '-' + cell.col)}
      {@const cue = app.cueAt(tab, cell.row, cell.col)}
      <div
        class="cell"
        class:hover={hoverKey === `${cell.row}-${cell.col}`}
        ondragover={(e) => onDragOver(e, cell.row, cell.col)}
        ondrop={(e) => onDrop(e, cell.row, cell.col)}
        oncontextmenu={(e) => onContext(e, cell.row, cell.col)}
      >
        {#if cue}
          {#key cue.id}
            <CueButton {cue} />
          {/key}
        {:else}
          <div class="empty" title="Right-click to add a cue"></div>
        {/if}

      </div>
    {/each}
  </div>
{/if}

<style>
  .grid {
    height: 100%;
    display: grid;
    gap: 8px;
    padding: 12px;
  }
  .cell {
    min-width: 0;
    min-height: 0;
    display: flex;
    border-radius: 8px;
  }
  .cell.hover {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
    background: rgba(59, 130, 246, 0.12);
  }
  .cell > :global(*) {
    flex: 1;
    min-width: 0;
  }
  .empty {
    width: 100%;
    height: 100%;
  }
  /* Signals that tiles can be picked up while the modifier is held. */
  .grid.dragready :global(.cue) {
    cursor: grab;
  }
  .grid.dragready :global(.cue:active) {
    cursor: grabbing;
  }
</style>
