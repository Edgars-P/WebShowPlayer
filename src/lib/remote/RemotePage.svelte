<script lang="ts">
  // The phone remote. A compact, touch-first mirror of the launchpad: a sticky
  // transport bar and an always-visible panic bar up top, a tab strip, and the
  // active tab's cues as a full-width vertical stack. Everything it shows comes
  // from the host's snapshot; every tap sends a whitelisted command back.
  //
  // Taps are optimistic: `predicted` folds every outstanding command's
  // locally-predicted effect on top of the last snapshot the host sent, so a
  // tap looks like it already happened instantly, with no "sent, waiting"
  // indicator for the common fast case. See `optimistic.ts` for exactly what
  // gets predicted and why (only the tapped control's own field, never a
  // neighbouring cue or a trigger chain).

  import { onMount } from 'svelte';
  import { remoteClient } from './remoteClient.svelte';
  import { formatTime } from '../timer/timer';
  import { predictSnapshot } from './optimistic';
  import type { RemoteCommand } from './protocol';
  import IconPlayFill from '~icons/bi/play-fill';
  import IconPauseFill from '~icons/bi/pause-fill';
  import IconStopFill from '~icons/bi/stop-fill';
  import IconCircleFill from '~icons/bi/circle-fill';
  import IconCircle from '~icons/bi/circle';
  import IconBlank from '~icons/bi/square';
  import IconCaretUpFill from '~icons/bi/caret-up-fill';
  import IconCaretDownFill from '~icons/bi/caret-down-fill';
  import IconProxy from '~icons/bi/arrow-left-right';
  import IconStopwatchFill from '~icons/bi/stopwatch-fill';
  import IconGlobalAll from '~icons/bi/collection-fill';
  import IconGlobalOne from '~icons/bi/file-earmark-fill';
  import type { SubtitleIcon } from './protocol';
  import type { Component } from 'svelte';

  const SUBTITLE_ICON: Record<Exclude<SubtitleIcon, null>, Component> = {
    proxy: IconProxy,
    timer: IconStopwatchFill,
    video: IconPlayFill,
    globalAll: IconGlobalAll,
    globalOne: IconGlobalOne,
  };

  let snap = $derived(remoteClient.snapshot);
  let status = $derived(remoteClient.status);
  let stale = $derived(remoteClient.stale);

  // Which tab the phone is *viewing*. Null means "follow the player"; tapping a
  // tab pins the view locally so browsing here never moves the operator's tab.
  // Always driven by the real snapshot, never predicted — tab browsing is
  // local-only and no command for it is ever sent.
  let localTab = $state<string | null>(null);
  let viewTabId = $derived(localTab ?? snap?.activeTabId ?? snap?.tabs[0]?.id ?? '');

  // ---- Optimistic prediction queue ------------------------------------------

  type Pending = { id: string; cmd: RemoteCommand; at: number };

  /** Safety net: revert to the authoritative snapshot if an ack/mismatch never
   *  arrives for a command (a dropped packet, a link that died mid-flight). */
  const PREDICTION_TIMEOUT_MS = 2500;
  /** A command outstanding longer than this gets a subtle "still confirming"
   *  hint — the common fast round trip never reaches it. */
  const SLOW_ACK_MS = 700;
  const QUEUE_TICK_MS = 300;

  let queue = $state<Pending[]>([]);
  let clockNow = $state(Date.now());

  /** The latest authoritative snapshot with every still-outstanding predicted
   *  command replayed on top, in send order. Depends only on `snap`/`queue` —
   *  never `clockNow` — so it doesn't recompute on every tick. */
  let predicted = $derived.by(() => {
    if (!snap) return null;
    let s = snap;
    for (const p of queue) s = predictSnapshot(s, p.cmd) ?? s;
    return s;
  });
  let tab = $derived(predicted?.tabs.find((t) => t.id === viewTabId) ?? predicted?.tabs[0] ?? null);

  function dispatch(cmd: RemoteCommand) {
    const id = remoteClient.send(cmd);
    if (id) queue = [...queue, { id, cmd, at: Date.now() }];
  }

  /**
   * activateCue needs the phone's current best guess of the cue's state, sent
   * along as `fromState` so the host can tell us whether that guess was
   * already stale by the time it processed the tap (see optimistic.ts's
   * header comment on AudioEngine.toggle()'s state-dependent branches).
   */
  function dispatchActivateCue(cueId: string) {
    const fromState = tab?.cues.find((c) => c.id === cueId)?.state ?? 'idle';
    dispatch({ t: 'activateCue', cueId, fromState });
  }

  /**
   * The control-key a command's slow-ack hint should key off, mirroring the
   * button layout below — pause and resume share one button, same for video.
   */
  function controlKey(cmd: RemoteCommand): string {
    switch (cmd.t) {
      case 'activateCue':
        return `cue-${cmd.cueId}`;
      case 'selectDoc':
        return `doc-${cmd.docId}`;
      case 'openScreen':
        return 'screen';
      case 'timerPause':
      case 'timerResume':
        return 'timer-play';
      case 'timerClear':
        return 'timer-clear';
      case 'videoPause':
      case 'videoResume':
        return 'video-play';
      case 'videoClear':
        return 'video-clear';
      case 'stopAll':
        return cmd.fade ? 'fade-all' : 'stop-all';
      default:
        return '';
    }
  }

  /** Commands outstanding long enough to show the subtle "still confirming"
   *  hint. Depends on `clockNow` (so it re-evaluates every tick) but never
   *  writes to `queue`/`predicted` itself. */
  let slowKeys = $derived.by(() => {
    const keys = new Set<string>();
    for (const p of queue) if (clockNow - p.at > SLOW_ACK_MS) keys.add(controlKey(p.cmd));
    return keys;
  });

  onMount(() => {
    remoteClient.start();
    const timer = setInterval(() => {
      clockNow = Date.now();
      if (queue.length && queue.some((p) => clockNow - p.at > PREDICTION_TIMEOUT_MS)) {
        queue = queue.filter((p) => clockNow - p.at <= PREDICTION_TIMEOUT_MS);
      }
    }, QUEUE_TICK_MS);
    return () => clearInterval(timer);
  });

  // Drop a queued prediction once the host confirms it landed as expected.
  $effect(() => {
    const acked = remoteClient.ackedIds;
    if (queue.some((p) => acked.has(p.id))) queue = queue.filter((p) => !acked.has(p.id));
  });

  // A mismatch means our model of "the last known state" was already stale
  // when the host processed one of our commands — any other still-queued
  // prediction from around the same window may be compounding on the same bad
  // assumption, so the safe response is to fall back entirely to the bundled
  // authoritative snapshot rather than trust the rest of the queue. Normal
  // single-tap use never reaches this; it's a rapid-double-tap-on-a-slow-link
  // safeguard.
  $effect(() => {
    if (remoteClient.mismatchedIds.size && queue.length) queue = [];
  });

  // A disconnect invalidates every outstanding prediction.
  $effect(() => {
    if (status !== 'connected' && queue.length) queue = [];
  });

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
    {#if predicted}<span class="doc">{predicted.docs.find((d) => d.id === predicted.activeDocId)?.title ?? ''}</span>{/if}
  </div>

  {#if status === 'error'}
    <div class="fatal">{remoteClient.error}</div>
  {:else if !predicted}
    <div class="empty">Waiting for the player…</div>
  {:else}
    <!-- Transport bar: screen / timer / video, mirroring the desktop toolbar. -->
    <div class="topbar">
      <button
        class="chip"
        class:on={predicted.screenLive}
        class:pending-ack={slowKeys.has('screen')}
        onclick={() => dispatch({ t: 'openScreen' })}
        title="Open the projector screen on the player"
      >
        Screen {#if predicted.screenLive}<IconCircleFill />{:else}<IconCircle />{/if}
      </button>

      <div class="chip group" class:live={predicted.timer.active}>
        <span class="clock">{predicted.timer.active ? formatTime(predicted.timer.remaining) : '—:—'}</span>
        <button
          class="mini"
          class:pending-ack={slowKeys.has('timer-play')}
          disabled={!predicted.timer.active || predicted.timer.finished}
          onclick={() => dispatch(predicted.timer.running ? { t: 'timerPause' } : { t: 'timerResume' })}
        >{#if predicted.timer.running}<IconPauseFill />{:else}<IconPlayFill />{/if}</button>
        <button
          class="mini"
          class:pending-ack={slowKeys.has('timer-clear')}
          disabled={!predicted.timer.active}
          onclick={() => dispatch({ t: 'timerClear' })}
        ><IconStopFill /></button>
      </div>

      <div class="chip group" class:live={predicted.video.active}>
        <span class="clock">{#if predicted.video.active}{formatTime(predicted.video.remaining)}{:else}<IconBlank />{/if}</span>
        <button
          class="mini"
          class:pending-ack={slowKeys.has('video-play')}
          disabled={!predicted.video.active}
          onclick={() => dispatch(predicted.video.playing ? { t: 'videoPause' } : { t: 'videoResume' })}
        >{#if predicted.video.playing}<IconPauseFill />{:else}<IconPlayFill />{/if}</button>
        <button
          class="mini"
          class:pending-ack={slowKeys.has('video-clear')}
          disabled={!predicted.video.active}
          onclick={() => dispatch({ t: 'videoClear' })}
        ><IconStopFill /></button>
      </div>
    </div>

    <!-- Panic bar: always visible, big targets. -->
    <div class="panic">
      <button
        class="fade"
        class:pending-ack={slowKeys.has('fade-all')}
        disabled={!predicted.anyPlaying}
        onclick={() => dispatch({ t: 'stopAll', fade: true })}
      >
        Fade all
      </button>
      <button
        class="stop"
        class:pending-ack={slowKeys.has('stop-all')}
        disabled={!predicted.anyPlaying}
        onclick={() => dispatch({ t: 'stopAll', fade: false })}
      >
        <IconStopFill /> Stop all
      </button>
    </div>

    {#if predicted.docs.length > 1}
      <div class="docs">
        {#each predicted.docs as d (d.id)}
          <button
            class="docbtn"
            class:active={d.id === predicted.activeDocId}
            class:pending-ack={slowKeys.has(`doc-${d.id}`)}
            onclick={() => dispatch({ t: 'selectDoc', docId: d.id })}
          >
            {d.title}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Tab strip: browsing here is local; a dot marks the player's live tab. -->
    <div class="tabs">
      {#each snap!.tabs as t (t.id)}
        <button class="tabbtn" class:active={t.id === viewTabId} onclick={() => (localTab = t.id)}>
          {t.name}{#if t.id === snap!.activeTabId}<span class="livedot" title="Live on the player"><IconCircleFill /></span>{/if}
        </button>
      {/each}
    </div>

    <!-- The cues, as a vertical stack. -->
    <div class="stack">
      {#if tab}
        {#each tab.cues as cue (cue.id)}
          {@const SubIcon = cue.subtitleIcon ? SUBTITLE_ICON[cue.subtitleIcon] : null}
          <button
            class="cue state-{cue.state}"
            class:missing={cue.missing}
            class:pending={cue.pending}
            class:unavailable={cue.unavailable}
            class:pending-ack={slowKeys.has(`cue-${cue.id}`)}
            style:--cue-color={cue.color}
            disabled={cue.unavailable}
            onclick={() => dispatchActivateCue(cue.id)}
          >
            <span class="swatch"></span>
            <span class="labels">
              <span class="name">{cue.name || '—'}</span>
              <span class="sub">{#if SubIcon}<SubIcon />{/if}{cue.subtitle}</span>
            </span>
            {#if cue.state !== 'idle'}
              <span class="live live-{cue.state}" title={cue.state}>
                {#if cue.state === 'fadingIn'}<IconCaretUpFill />{:else if cue.state === 'fadingOut'}<IconCaretDownFill />{/if}
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
    font-size: 8px;
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
  .sub :global(svg) {
    margin-right: 3px;
  }
  /* The live badge carries the fade *direction*, statically: a dot means
     playing, an up caret fading in, a down caret fading out — a glance tells the three apart. The
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

  /* A command still hasn't been confirmed after a while — not the fast common
     case (which shows nothing beyond the instant predicted state change), but
     long enough that the operator might wonder if the tap registered. No
     animation: a static, subtle dim signals "still working on it" without
     nagging like the old ring-pulse did. */
  .pending-ack {
    opacity: 0.7;
  }
  .mini.pending-ack {
    opacity: 0.55;
  }
</style>
