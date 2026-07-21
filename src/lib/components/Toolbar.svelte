<script lang="ts">
  import { app } from '../state/project.svelte';
  import { trello } from '../state/trello.svelte';
  import { remoteHost } from '../remote/remoteHost.svelte';
  import { formatTime, timerColor } from '../timer/timer';

  let project = $derived(app.project);
  let timer = $derived(app.timer);
  let timerActive = $derived(timer.duration > 0 || timer.finished);
  let progress = $derived(app.progressView);
  let memory = $derived(app.audioMemory);

  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);

  // The video readout counts down the clip, so it reads like the timer beside
  // it; the tooltip carries what that number is counting.
  let videoTitle = $derived(
    !app.videoActive
      ? 'Nothing on the screen'
      : app.videoStatus.duration > 0
        ? `${app.videoStatus.playing ? 'Playing' : 'Held'} — ${formatTime(app.videoStatus.position)} of ${formatTime(app.videoStatus.duration)}`
        : 'A clip holds the screen',
  );
</script>

{#if project}
  <div class="toolbar">
    <div class="row">
      <strong class="brand">Show Player</strong>
      <button class="ghost" onclick={() => app.openFolder()}>Open…</button>
      <button class="ghost" title="Open or create a cue file" onclick={() => app.showChooser()}>Files…</button>
      <button class="ghost" onclick={() => app.save()} disabled={!app.dirty} title={`Save to ${app.saveName}`}>
        Save{app.dirty ? ' *' : ''}
      </button>
      <span class="file" title="Current cue file">{app.saveName}</span>
      {#if progress.total > 0 && progress.done < progress.total}
        <span class="file">decoding {progress.done}/{progress.total}…</span>
      {:else if memory.files > 0}
        <span
          class="file"
          class:heavy={memory.bytes > 2 * 1024 ** 3}
          title={`${memory.files} distinct audio files decoded to raw PCM across all open documents.\nEach cue holding a file keeps it resident; identical files are shared, not duplicated.`}
        >
          {gb(memory.bytes)} GB audio
        </span>
      {/if}
    </div>

    <div class="row">
      <label for="grid-cols">Grid</label>
      <input
        id="grid-cols"
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
        aria-label="Rows"
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
    </div>

    <div class="row timer">
      <span class="clock video" class:live={app.videoActive} title={videoTitle}>
        {#if app.videoActive && app.videoStatus.duration > 0}
          {formatTime(app.videoStatus.duration - app.videoStatus.position)}
        {:else if app.videoActive}
          ▶ video
        {:else}
          ▢
        {/if}
      </span>
      <button
        class="ghost icon"
        title={app.video.playing ? 'Pause clip' : 'Resume clip'}
        disabled={!app.videoActive}
        onclick={() => (app.video.playing ? app.pauseVideo() : app.resumeVideo())}
      >
        {app.video.playing ? '⏸' : '▶'}
      </button>
      <button
        class="ghost icon"
        title="Take the clip off the screen"
        disabled={!app.videoActive}
        onclick={() => app.clearVideo()}
      >
        ⏹
      </button>
      <button
        class="ghost"
        class:on={app.screenLive}
        title={app.screenLive
          ? 'Screen is up — focus it'
          : 'Open the projector screen. Video cues need it: without a screen they do nothing.'}
        onclick={() => app.openScreenWindow()}
      >
        Screen
      </button>
    </div>

    <div class="row">
      <button
        class="ghost"
        class:on={trello.settings.enabled}
        title="Follow the first list of a Trello board in a sidebar"
        onclick={() => trello.toggleEnabled()}
      >
        Trello
      </button>
      <button
        class="ghost"
        class:on={remoteHost.enabled}
        title="Control the player from a phone"
        onclick={() => (remoteHost.panelOpen = !remoteHost.panelOpen)}
      >
        Remote{#if remoteHost.peerCount > 0}<span class="badge">{remoteHost.peerCount}</span>{/if}
      </button>
    </div>

    <div class="row">
      <button
        class="ghost stopall"
        title="Fade out everything in every open cue file, using each cue's own fade time"
        disabled={!app.anyPlaying}
        onclick={() => app.stopAllAudio(true)}
      >
        Fade out all
      </button>
      <button
        class="ghost stopall danger"
        title="Stop everything in every open cue file immediately, ignoring fades"
        disabled={!app.anyPlaying}
        onclick={() => app.stopAllAudio(false)}
      >
        ⏹ Stop all
      </button>
    </div>

    <div class="row">
      <label for="master-volume">Master</label>
      <input
        id="master-volume"
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
  .file.heavy {
    color: var(--warn);
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
  /* The video readout sits in the same slot as the clock, so the two groups
     line up; it says only whether the screen is holding a picture. */
  .clock.video {
    font-size: 13px;
    color: var(--muted);
  }
  .clock.video.live {
    color: var(--accent);
  }
  .icon {
    padding: 4px 8px;
  }
  .stopall:not(:disabled) {
    border-color: var(--border);
  }
  .stopall.danger:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .stopall:disabled {
    opacity: 0.4;
  }
  .on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .badge {
    display: inline-block;
    margin-left: 5px;
    padding: 0 6px;
    border-radius: 9px;
    background: var(--ok);
    color: #06210f;
    font-size: 11px;
    font-weight: 700;
    line-height: 16px;
  }
</style>
