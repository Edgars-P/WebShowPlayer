<script lang="ts">
  // The countdown half of the projector screen. Pure display: it's handed a
  // TimerView and told whether it currently has the screen.
  import { scale } from 'svelte/transition';
  import { formatTime, remainingFraction, timerColor, type TimerView } from '../timer/timer';

  let { view, hidden = false }: { view: TimerView; hidden?: boolean } = $props();

  // While running, we don't trust the (background-throttled) opener's push cadence
  // for the displayed value — we recompute `remaining` from the shared wall clock
  // every animation frame. This keeps the number and bar smooth and always in sync,
  // regardless of how sparsely snapshots arrive. `now` ticks only while running.
  let now = $state(Date.now());
  $effect(() => {
    if (!view.running || view.endsAt == null) return;
    let raf = 0;
    const loop = () => {
      now = Date.now();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  // Effective, frame-accurate remaining: derived from the end timestamp when
  // running, otherwise the frozen value the opener last pushed (pause/finish).
  let remaining = $derived(
    view.running && view.endsAt != null ? Math.max(0, (view.endsAt - now) / 1000) : view.remaining,
  );
  let effective = $derived<TimerView>({ ...view, remaining });

  // `hidden` folds into the same "nothing to show" condition an unset timer
  // already uses, so a video taking the screen floats the clock out exactly the
  // way clearing it does.
  let clear = $derived(hidden || (view.duration <= 0 && !view.finished));
  let paused = $derived(!clear && !view.finished && !view.running);
  let color = $derived(timerColor(effective));
  // timerColor's hue: 120 (green) → 0 (red). Only the red tail should glow, ramping
  // in as tension builds — no glow at all while still green/yellow.
  let hue = $derived(120 * remainingFraction(effective));
  let glow = $derived(view.finished ? 1 : Math.max(0, 1 - hue / 35));
  let glowShadow = $derived(
    glow > 0 ? `0 0 ${(1 + glow * 5).toFixed(2)}vh rgba(255, 50, 50, ${(0.15 + glow * 5).toFixed(2)})` : 'none',
  );
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
      {formatTime(effective.remaining)}
    </div>
    <div class="track" in:scale={{ duration: 450, start: 0.7 }} out:scale={{ duration: 450, start: 0.7 }}>
      <div
        class="bar"
        style:background={color}
        style:transform={`scaleX(${remainingFraction(effective)})`}
      ></div>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: 'Bahnschrift', system-ui, sans-serif;
  }

  .time {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: min(26vw, 46vh);
    line-height: 1;
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
    width: 100%;
    border-radius: inherit;
    /* The bar is scaled (not resized) per frame by requestAnimationFrame (see the
       script above). transform: scaleX is a compositor-only property, so each
       frame skips layout and paint entirely — the GPU just re-composites the
       existing layer. Animating `width` instead would force a full layout+paint on
       every frame. Default transform-origin (centre) keeps the old symmetric shrink.
       The scale itself must apply instantly, so only colour eases. */
    transform-origin: center;
    transition: background 0.3s ease;
    will-change: transform;
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
