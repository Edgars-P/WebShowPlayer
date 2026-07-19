<script lang="ts">
  // Projector pop-out page (mounted at screen.html). Same-origin popup: reads
  // its live state from a bridge the opener (ScreenWindow) attaches to its own
  // window, and reports the one thing only this side knows — that a clip ended.
  import { onDestroy, onMount } from 'svelte';
  import TimerLayer from './TimerLayer.svelte';
  import VideoLayer from './VideoLayer.svelte';
  import { EMPTY_VIDEO, type ScreenBridge, type ScreenView } from './screen';
  import { EMPTY_TIMER } from '../timer/timer';

  // Copies, not the shared constants: $state proxies what it's given, and a
  // mutation through the proxy would reach back into the module-level defaults.
  let view = $state<ScreenView>({ timer: { ...EMPTY_TIMER }, video: { ...EMPTY_VIDEO } });

  let bridge: ScreenBridge | undefined;
  let unsubscribe: (() => void) | null = null;

  /** How often to check that the show we're displaying still exists. */
  const WATCHDOG_MS = 500;

  function openerBridge(): ScreenBridge | undefined {
    try {
      const opener = window.opener as unknown as
        | ({ closed: boolean; __screenBridge?: ScreenBridge })
        | null;
      return opener && !opener.closed ? opener.__screenBridge : undefined;
    } catch {
      return undefined; // opener gone, or no longer reachable
    }
  }

  /**
   * Point this page at a bridge — or at nothing, which blanks it.
   *
   * Taking the new bridge's snapshot is what does the blanking: a freshly
   * reloaded opener has empty slots, so the screen clears itself and then
   * carries on live under the new one.
   */
  function attach(next: ScreenBridge | undefined) {
    unsubscribe?.();
    unsubscribe = null;
    bridge = next;
    view = next ? next.getSnapshot() : { timer: { ...EMPTY_TIMER }, video: { ...EMPTY_VIDEO } };
    if (next) unsubscribe = next.subscribe((v) => (view = v));
  }

  onMount(() => {
    attach(openerBridge());
    // The opener can go away underneath us — closed, reloaded, or hot-reloaded
    // mid-session — and nothing tells us when it does: we'd simply stop
    // receiving pushes and sit there showing the last frame of a show that no
    // longer exists, in front of an audience. So we watch for the bridge being
    // swapped or lost, and blank rather than lie.
    const watchdog = setInterval(() => {
      const next = openerBridge();
      if (next !== bridge) attach(next);
    }, WATCHDOG_MS);
    return () => clearInterval(watchdog);
  });

  onDestroy(() => unsubscribe?.());

  /** Going away: drop the subscription, and let the opener free the slot. */
  function detach() {
    unsubscribe?.();
    unsubscribe = null;
    bridge?.screenClosing();
  }
</script>

<!-- Closing this window takes the picture with it, and the opener has to know:
     it holds the slot, and would otherwise keep claiming a clip is on a screen
     that no longer exists. `pagehide` fires on close, unlike unload in some
     cases, and needs no user interaction. -->
<svelte:window onpagehide={detach} />

<!-- Video outranks the timer: a picture on the screen is there to be looked at,
     so the clock gets out of its way and floats back in when the clip is done. -->
<div class="screen">
  <TimerLayer view={view.timer} hidden={view.video.file != null} />
  <VideoLayer
    view={view.video}
    onended={(gen) => bridge?.videoEnded(gen)}
    onprogress={(gen, status) => bridge?.videoProgress(gen, status)}
  />
</div>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    margin: 0;
    height: 100%;
    background: #000;
    overflow: hidden;
  }

  .screen {
    position: relative;
    height: 100%;
    background: #000;
  }
</style>
