<script lang="ts">
  // The phone remote. A compact, touch-first mirror of the launchpad: a sticky
  // transport bar and an always-visible panic bar up top, a tab strip, and the
  // active tab's cues as a full-width vertical stack. Everything it shows comes
  // from the host's snapshot; every tap sends a whitelisted command back.

  import { onMount } from 'svelte';
  import { remoteClient } from './remoteClient.svelte';
  import { formatTime } from '../timer/timer';
  import type { RemoteCommand } from './protocol';

  onMount(() => remoteClient.start());

  let snap = $derived(remoteClient.snapshot);
  let status = $derived(remoteClient.status);
  let stale = $derived(remoteClient.stale);

  // Which tab the phone is *viewing*. Null means "follow the player"; tapping a
  // tab pins the view locally so browsing here never moves the operator's tab.
  let localTab = $state<string | null>(null);
  let viewTabId = $derived(localTab ?? snap?.activeTabId ?? snap?.tabs[0]?.id ?? '');
  let tab = $derived(snap?.tabs.find((t) => t.id === viewTabId) ?? snap?.tabs[0] ?? null);

  function send(cmd: RemoteCommand) {
    remoteClient.send(cmd);
  }

  let statusText = $derived(
    stale && status === 'connected'
      ? 'Live feed stalled…'
      : status === 'connected'
        ? 'Connected'
        : status === 'connecting'
          ? 'Connecting…'
          : status === 'reconnecting'
            ? 'Reconnecting…'
            : 'Not connected',
  );
</script>

<div class="remote">
  <div
    class="conn"
    class:ok={status === 'connected' && !stale}
    class:warn={status === 'reconnecting' || status === 'connecting' || stale}
  >
    <span class="dot"></span>
    <span>{statusText}</span>
    {#if snap}<span class="doc">{snap.docs.find((d) => d.id === snap.activeDocId)?.title ?? ''}</span>{/if}
  </div>

  {#if status === 'error'}
    <div class="fatal">{remoteClient.error}</div>
  {:else if !snap}
    <div class="empty">Waiting for the player…</div>
  {:else}
    <!-- Transport bar: screen / timer / video, mirroring the desktop toolbar. -->
    <div class="topbar">
      <button
        class="chip"
        class:on={snap.screenLive}
        onclick={() => send({ t: 'openScreen' })}
        title="Open the projector screen on the player"
      >
        Screen {snap.screenLive ? '●' : '○'}
      </button>

      <div class="chip group" class:live={snap.timer.active}>
        <span class="clock">{snap.timer.active ? formatTime(snap.timer.remaining) : '—:—'}</span>
        <button
          class="mini"
          disabled={!snap.timer.active || snap.timer.finished}
          onclick={() => send(snap.timer.running ? { t: 'timerPause' } : { t: 'timerResume' })}
        >{snap.timer.running ? '⏸' : '▶'}</button>
        <button class="mini" disabled={!snap.timer.active} onclick={() => send({ t: 'timerClear' })}>⏹</button>
      </div>

      <div class="chip group" class:live={snap.video.active}>
        <span class="clock">{snap.video.active ? formatTime(snap.video.remaining) : '▢'}</span>
        <button
          class="mini"
          disabled={!snap.video.active}
          onclick={() => send(snap.video.playing ? { t: 'videoPause' } : { t: 'videoResume' })}
        >{snap.video.playing ? '⏸' : '▶'}</button>
        <button class="mini" disabled={!snap.video.active} onclick={() => send({ t: 'videoClear' })}>⏹</button>
      </div>
    </div>

    <!-- Panic bar: always visible, big targets. -->
    <div class="panic">
      <button class="fade" disabled={!snap.anyPlaying} onclick={() => send({ t: 'stopAll', fade: true })}>
        Fade all
      </button>
      <button class="stop" disabled={!snap.anyPlaying} onclick={() => send({ t: 'stopAll', fade: false })}>
        ⏹ Stop all
      </button>
    </div>

    {#if snap.docs.length > 1}
      <div class="docs">
        {#each snap.docs as d (d.id)}
          <button class="docbtn" class:active={d.id === snap.activeDocId} onclick={() => send({ t: 'selectDoc', docId: d.id })}>
            {d.title}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Tab strip: browsing here is local; a • marks the player's live tab. -->
    <div class="tabs">
      {#each snap.tabs as t (t.id)}
        <button class="tabbtn" class:active={t.id === viewTabId} onclick={() => (localTab = t.id)}>
          {t.name}{#if t.id === snap.activeTabId}<span class="livedot" title="Live on the player">•</span>{/if}
        </button>
      {/each}
    </div>

    <!-- The cues, as a vertical stack. -->
    <div class="stack">
      {#if tab}
        {#each tab.cues as cue (cue.id)}
          <button
            class="cue state-{cue.state}"
            class:missing={cue.missing}
            class:pending={cue.pending}
            class:unavailable={cue.unavailable}
            style:--cue-color={cue.color}
            disabled={cue.unavailable}
            onclick={() => send({ t: 'activateCue', cueId: cue.id })}
          >
            <span class="swatch"></span>
            <span class="labels">
              <span class="name">{cue.name || '—'}</span>
              <span class="sub">{cue.subtitle}</span>
            </span>
            {#if cue.state !== 'idle'}
              <span class="live live-{cue.state}" title={cue.state}>
                {#if cue.state === 'fadingIn'}▲{:else if cue.state === 'fadingOut'}▼{/if}
              </span>
            {/if}
          </button>
        {:else}
          <div class="empty">This tab has no cues.</div>
        {/each}
      {:else}
        <div class="empty">No show open on the player.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* app.css (shared with the main player) fixes html/body/#app to exactly one
     viewport tall with `overflow: hidden` — right for the player's own
     internally-scrolling panels, but it means this page's body can never
     scroll, so a cue list longer than one screen is simply clipped. Override
     it here: same selectors, so this just wins the cascade by coming later
     (RemotePage is imported after app.css in remote-main.ts). */
  :global(html),
  :global(body) {
    height: auto;
    min-height: 100%;
    overflow-y: auto;
  }

  .remote {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
  }

  .conn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .conn .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--danger);
  }
  .conn.warn .dot {
    background: var(--warn);
  }
  .conn.ok .dot {
    background: var(--ok);
  }
  .conn .doc {
    margin-left: auto;
    color: var(--text);
    font-weight: 600;
  }

  .fatal,
  .empty {
    padding: 24px 16px;
    color: var(--muted);
    text-align: center;
  }
  .fatal {
    color: var(--danger);
  }

  /* Sticky so transport + panic stay reachable while the cue list scrolls. */
  .topbar,
  .panic {
    position: sticky;
    z-index: 2;
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    background: var(--panel);
    flex-wrap: wrap;
  }
  .topbar {
    top: 0;
    border-bottom: 1px solid var(--border);
  }
  .panic {
    top: 52px;
    border-bottom: 1px solid var(--border);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 13px;
    color: var(--text);
  }
  .chip.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .chip.group.live {
    border-color: var(--accent);
  }
  .clock {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    min-width: 46px;
    text-align: right;
  }
  .mini {
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 15px;
    padding: 2px 4px;
    min-width: 28px;
  }
  .mini:disabled {
    opacity: 0.35;
  }

  .panic button {
    flex: 1;
    padding: 14px;
    font-size: 15px;
    font-weight: 700;
    border-radius: 8px;
  }
  .fade {
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .stop {
    background: #3a1c1c;
    border: 1px solid var(--danger);
    color: #ffd9d9;
  }
  .panic button:disabled {
    opacity: 0.4;
  }

  .docs,
  .tabs {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    overflow-x: auto;
  }
  .docbtn,
  .tabbtn {
    white-space: nowrap;
    background: var(--panel-2);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text);
    font-size: 13px;
  }
  .docbtn.active,
  .tabbtn.active {
    border-color: var(--accent);
  }
  .livedot {
    color: var(--ok);
    margin-left: 4px;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 24px;
  }
  /* A cue row. The swatch always carries the cue's own colour; an active row
     fills with a wash of it so a live cue reads at a glance while scrolling. */
  .cue {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 12px;
    min-height: 56px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    color: var(--text);
  }
  .cue .swatch {
    width: 6px;
    align-self: stretch;
    border-radius: 3px;
    background: var(--cue-color, var(--muted));
    flex: none;
  }
  .labels {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The live badge carries the fade *direction*, statically: a dot means
     playing, ▲ fading in, ▼ fading out — a glance tells the three apart. The
     border colour reinforces it: cue-coloured steady, green rising, amber
     falling. No motion — a show is watched for hours and a pulse only nags. */
  .cue .live {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 800;
    line-height: 1;
    flex: none;
    color: #06210f;
  }
  .cue .live-playing {
    background: var(--accent);
  }
  .cue .live-fadingIn {
    background: var(--ok);
  }
  .cue .live-fadingOut {
    background: var(--warn);
    color: #3a2400;
  }
  .cue.state-playing,
  .cue.state-fadingIn,
  .cue.state-fadingOut {
    background: color-mix(in oklab, var(--cue-color) 22%, var(--panel));
  }
  .cue.state-playing {
    border-color: color-mix(in oklab, var(--cue-color) 70%, var(--border));
  }
  .cue.state-fadingIn {
    border-color: var(--ok);
  }
  .cue.state-fadingOut {
    border-color: var(--warn);
  }
  .cue.missing {
    border-style: dashed;
    border-color: var(--danger);
  }
  .cue.pending {
    opacity: 0.6;
  }
  .cue.unavailable {
    filter: saturate(0.15);
    opacity: 0.6;
  }
</style>
