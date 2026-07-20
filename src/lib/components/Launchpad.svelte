<script lang="ts">
  import { app, type MenuItem } from '../state/project.svelte';
  import { isAudioFile } from '../fs/projectFs';
  import CueButton from './CueButton.svelte';
  import { cueDrag } from './cueDrag.svelte';

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

  // Cue tiles are picked up with a modifier held, so an ordinary click during a
  // show can't nudge one out of place. Tracked here only to put a grab cursor on
  // the tiles — the gesture itself reads the modifier off its own press, so a
  // missed keydown costs an affordance rather than the drag.
  function syncModifiers(e: KeyboardEvent | MouseEvent) {
    app.dragModifier = e.shiftKey || e.altKey || e.ctrlKey;
  }
  function clearModifiers() {
    app.dragModifier = false;
  }

  // Only external OS file drops come through native DnD now; cues moving inside
  // the app are a pointer gesture (see cueDrag).
  async function onDrop(e: DragEvent, row: number, col: number) {
    e.preventDefault();
    hoverKey = null;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => isAudioFile(f.name));
    if (files.length) await app.importAudioFiles(files, row, col);
  }

  function onDragOver(e: DragEvent, row: number, col: number) {
    if (!dropHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    hoverKey = `${row}-${col}`;
  }

  /** A copy can't land on an occupied cell, and shouldn't invite the attempt. */
  let dropBlocked = $derived(
    cueDrag.copy &&
      cueDrag.target?.kind === 'cell' &&
      !!tab &&
      !!app.cueAt(tab, cueDrag.target.row, cueDrag.target.col),
  );
  let carried = $derived(cueDrag.id ? (app.activeDoc?.findCue(cueDrag.id) ?? null) : null);

  function onContext(e: MouseEvent, row: number, col: number) {
    e.preventDefault();
    if (!tab) return;
    const cue = app.cueAt(tab, row, col);
    let items: MenuItem[];
    if (cue) {
      items = [{ label: 'Properties…', action: () => app.openProperties(cue.id) }];
      // Dragging onto a tab does the same thing, but needs a modifier held and
      // isn't discoverable; this is the obvious path.
      for (const t of project?.tabs ?? []) {
        if (t.id === tab.id) continue;
        items.push({ label: `Move to “${t.name}”`, action: () => app.moveCueToTab(cue.id, t.id) });
      }
      items.push({ label: 'Delete cue', danger: true, action: () => app.removeCue(cue.id) });
    } else {
      items = [
        { label: 'Add audio cue', action: () => app.addNewCue('audio', row, col) },
        { label: 'Add proxy cue', action: () => app.addNewCue('proxy', row, col) },
        { label: 'Add timer cue', action: () => app.addNewCue('timer', row, col) },
        { label: 'Add video cue', action: () => app.addNewCue('video', row, col) },
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
    role="presentation"
  >
    {#each cells(project.grid.rows, project.grid.cols) as cell (cell.row + '-' + cell.col)}
      {@const cue = app.cueAt(tab, cell.row, cell.col)}
      <div
        class="cell"
        class:hover={hoverKey === `${cell.row}-${cell.col}` || cueDrag.overCell(cell.row, cell.col)}
        class:blocked={dropBlocked && cueDrag.overCell(cell.row, cell.col)}
        data-drop={`cell:${cell.row}:${cell.col}`}
        ondragover={(e) => onDragOver(e, cell.row, cell.col)}
        ondrop={(e) => onDrop(e, cell.row, cell.col)}
        oncontextmenu={(e) => onContext(e, cell.row, cell.col)}
        role="presentation"
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

  <!-- What's being carried. The native drag image was a screenshot of the tile
       taken at press time and frozen; this one is live, and says which of move
       and copy the current modifiers have chosen. -->
  {#if carried}
    {@const info = app.display(carried)}
    <div
      class="carry"
      class:blocked={dropBlocked}
      style:left="{cueDrag.x}px"
      style:top="{cueDrag.y}px"
      style:--cue-color={info.color}
    >
      <span class="verb">{cueDrag.copy ? '＋' : '→'}</span>
      {info.name || carried.type}
    </div>
  {/if}
{/if}

<style>
  .grid {
    /* The gap between tiles is drawn by each cell's own padding rather than by
       grid-gap, so the cells tile the whole grid with no dead space between
       them. Cues own the gap around them; see CueButton's hit area. */
    --tile-gap: 8px;
    height: 100%;
    display: grid;
    gap: 0;
    padding: calc(12px - var(--tile-gap) / 2);
  }
  .cell {
    min-width: 0;
    min-height: 0;
    display: flex;
    border-radius: 12px;
  }
  .cell.hover {
    outline: 2px dashed var(--accent);
    /* Pull the drop hint in to the visible tile edge, off the neighbours. */
    outline-offset: calc(var(--tile-gap) / -2 - 2px);
    background: rgba(59, 130, 246, 0.12);
  }
  /* A copy landing on an occupied cell would do nothing, so the hint says so
     rather than promising a drop that won't happen. */
  .cell.blocked {
    outline-color: var(--danger);
    background: rgba(239, 68, 68, 0.12);
  }
  .cell > :global(*) {
    flex: 1;
    min-width: 0;
  }
  .empty {
    width: 100%;
    height: 100%;
  }
  /* The carried tile. Offset off the pointer so it never covers the cell it is
     about to land in, and transparent to hit-testing so the cell under the
     pointer is the cell, not this. */
  .carry {
    position: fixed;
    z-index: 60;
    transform: translate(14px, 10px);
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid oklch(from var(--cue-color) 0.65 c h);
    background: oklch(from var(--cue-color) 0.245 calc(c * 0.55) h);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .carry.blocked {
    border-color: var(--danger);
  }
  .verb {
    opacity: 0.7;
  }

  /* Signals that tiles can be picked up while the modifier is held. */
  .grid.dragready :global(.hit) {
    cursor: grab;
  }
  .grid.dragready :global(.hit:active) {
    cursor: grabbing;
  }
</style>
