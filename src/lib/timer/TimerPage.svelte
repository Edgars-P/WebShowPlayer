<script lang="ts">
  // Projector pop-out page (mounted at timer.html). Same-origin popup: reads its
  // live state from a bridge the opener (TimerWindow.open) attaches to this window.
  import { onDestroy, onMount } from 'svelte';
  import { scale } from 'svelte/transition';
  import { formatTime, remainingFraction, timerColor, type TimerBridge, type TimerView } from './timer';

  let view = $state<TimerView>({ duration: 0, remaining: 0, running: false, finished: false });

  let clear = $derived(view.duration <= 0 && !view.finished);
  let paused = $derived(!clear && !view.finished && !view.running);
  let color = $derived(timerColor(view));
  // timerColor's hue: 120 (green) → 0 (red). Only the red tail should glow, ramping
  // in as tension builds — no glow at all while still green/yellow.
  let hue = $derived(120 * remainingFraction(view));
  let glow = $derived(view.finished ? 1 : Math.max(0, 1 - hue / 35));
  let glowShadow = $derived(
    glow > 0 ? `0 0 ${(1 + glow * 5).toFixed(2)}vh rgba(255, 50, 50, ${(0.15 + glow * 5).toFixed(2)})` : 'none',
  );

  let unsubscribe: (() => void) | null = null;

  onMount(() => {
    const bridge = (window.opener as unknown as { __timerBridge?: TimerBridge } | null)?.__timerBridge;
    if (!bridge) return;
    view = bridge.getSnapshot();
    unsubscribe = bridge.subscribe((v) => (view = v));
  });

  onDestroy(() => unsubscribe?.());
</script>

<div class="wrap" class:paused class:finished={view.finished}>
  {#if !clear}
    <div
      class="time"
      style:color
      style:text-shadow={glowShadow}
      in:scale={{ duration: 450, start: 0.7 }}
      out:scale={{ duration: 450, start: 0.7 }}
    >
      {formatTime(view.remaining)}
    </div>
    <div class="track" in:scale={{ duration: 450, start: 0.7 }} out:scale={{ duration: 450, start: 0.7 }}>
      <div
        class="bar"
        style:background={color}
        style:box-shadow={`0 0 1.4vh ${color}`}
        style:width={`${remainingFraction(view) * 100}%`}
      ></div>
    </div>
  {/if}
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

  .wrap {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #000;
    font-family: 'Segoe UI', system-ui, sans-serif;
  }

  .time {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: min(26vw, 46vh);
    line-height: 1;
    letter-spacing: 0.02em;
    transition: color 0.3s ease, text-shadow 0.3s ease, opacity 0.3s ease, transform 0.3s ease;
  }

  .track {
    position: fixed;
    left: 4%;
    right: 4%;
    bottom: 3%;
    height: 1.6vh;
    border-radius: 999px;
    background: #000;
    overflow: hidden;
    transition: opacity 0.3s ease;
  }

  .bar {
    height: 100%;
    border-radius: inherit;
    /* Continuous property changes (width tracking the countdown) stay CSS-driven;
       only mount/unmount of the track uses the Svelte transition above. */
    transition: width 0.2s linear, background 0.3s ease, box-shadow 0.3s ease;
  }

  /* Paused: clearly dimmed, but still on-screen. */
  .wrap.paused .time,
  .wrap.paused .track {
    opacity: 0.7;
  }
  .wrap.paused .time {
    transform: scale(0.96);
  }

  /* Smooth breathing fade when finished (no hard flashing). */
  .wrap.finished .time,
  .wrap.finished .track {
    animation: breathe 1.4s ease-in-out infinite;
  }
  @keyframes breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.2;
    }
  }
</style>
