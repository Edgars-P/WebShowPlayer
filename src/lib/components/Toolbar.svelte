<script lang="ts">
  import { app } from '../state/project.svelte';
  import { formatTime, timerColor } from '../timer/timer';

  let project = $derived(app.project);
  let timer = $derived(app.timer);
  let timerActive = $derived(timer.duration > 0 || timer.finished);
</script>

{#if project}
  <div class="toolbar">
    <div class="row">
      <strong class="brand">Show Player</strong>
      <button class="ghost" onclick={() => app.openFolder()}>Open…</button>
      {#if app.cueFiles.length > 1}
        <button class="ghost" title="Switch cue file" onclick={() => app.showChooser()}>Files…</button>
      {/if}
      <button class="ghost" onclick={() => app.save()} disabled={!app.dirty} title={`Save to ${app.saveName}`}>
        Save{app.dirty ? ' *' : ''}
      </button>
      <span class="file" title="Current cue file">{app.saveName}</span>
    </div>

    <div class="row">
      <label>Grid</label>
      <input
        class="num"
        type="number"
        min="1"
        max="16"
        value={project.grid.cols}
        oninput={(e) => app.setGrid(project.grid.rows, +e.currentTarget.value)}
        title="Columns"
      />
      <span class="times">×</span>
      <input
        class="num"
        type="number"
        min="1"
        max="16"
        value={project.grid.rows}
        oninput={(e) => app.setGrid(+e.currentTarget.value, project.grid.cols)}
        title="Rows"
      />
    </div>

    <div class="row timer">
      <span class="clock" style:color={timerActive ? timerColor(timer) : 'var(--muted)'}>
        {timerActive ? formatTime(timer.remaining) : '—:—'}
      </span>
      <button
        class="ghost icon"
        title={timer.running ? 'Pause' : 'Resume'}
        disabled={!timerActive || timer.finished}
        onclick={() => (timer.running ? app.pauseTimer() : app.resumeTimer())}
      >
        {timer.running ? '⏸' : '▶'}
      </button>
      <button class="ghost icon" title="Clear timer" disabled={!timerActive} onclick={() => app.clearTimer()}>
        ⏹
      </button>
      <button class="ghost" title="Open projector window" onclick={() => app.openTimerWindow()}>
        Pop-out
      </button>
    </div>

    <div class="row">
      <label>Master</label>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={project.masterVolume}
        oninput={(e) => app.setMasterVolume(+e.currentTarget.value)}
      />
    </div>
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .brand {
    margin-right: 4px;
  }
  .file {
    color: var(--muted);
    font-size: 12px;
    margin-left: 2px;
  }
  .num {
    width: 52px;
  }
  .times {
    color: var(--muted);
  }
  .timer .clock {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 16px;
    min-width: 56px;
    text-align: right;
  }
  .icon {
    padding: 4px 8px;
  }
</style>
