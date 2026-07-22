<script lang="ts">
  // The video half of the projector screen. Owns the media element, and with it
  // the only authoritative playback position — the opener sets intent (which
  // clip, playing or not) and hears back only when the clip reaches its end.
  import type { VideoStatus, VideoView } from './screen';

  let {
    view,
    onended,
    onprogress,
  }: {
    view: VideoView;
    onended: (generation: number) => void;
    onprogress: (generation: number, status: VideoStatus) => void;
  } = $props();

  let el = $state<HTMLVideoElement | null>(null);
  let src = $state<string | null>(null);
  /**
   * The picture's own fade, 0..1 — driven every frame from the same clip-clock
   * ramp that fades the audio (see the tick loop below), in place of a fixed
   * mount/unmount transition. Set up front on load so a clip with a fade-in
   * doesn't flash at full opacity for the frame before the first tick runs.
   */
  let opacity = $state(1);
  /**
   * Muting we imposed ourselves to get past the autoplay policy, as opposed to
   * the muting the cue asked for.
   */
  let forcedMute = $state(false);
  let blocked = $state(false);

  /**
   * Every field the effects below key off, pulled out one at a time.
   *
   * The opener pushes a whole new view object on every change — several times a
   * second while the timer runs — so an effect that reads `view.anything`
   * re-runs on every push, whether or not the thing it cares about moved. That
   * is ruinous here: it would mint a new object URL and reload the element five
   * times a second, and a resume would land on a clip that was busy tearing
   * itself down. A `$derived` only notifies when its value genuinely changes, so
   * reloading tracks the clip and nothing else.
   */
  let file = $derived(view.file);
  let generation = $derived(view.generation);
  let wantPlaying = $derived(view.playing);
  let seekToken = $derived(view.seekToken);
  let seekPosition = $derived(view.seekPosition);
  let startTime = $derived(view.startTime);

  /** Trimmed-in point past which loading a fresh clip should seek. */
  function onLoadedMetadata() {
    if (el && startTime > 0) el.currentTime = startTime;
  }

  // One object URL per loaded clip. Keyed on `generation` as well as the File so
  // that re-firing the same clip mints a fresh URL and restarts it from zero,
  // rather than leaving the element parked on its last frame.
  $effect(() => {
    void generation;
    const clip = file;
    forcedMute = false;
    blocked = false;
    // Start invisible if this clip eases in — the tick loop takes over from
    // here the moment it runs, a frame later.
    opacity = view.fadeIn > 0 ? 0 : 1;
    if (!clip) {
      src = null;
      return;
    }
    const url = URL.createObjectURL(clip);
    src = url;
    return () => {
      // No exit transition holds the element on screen anymore (the fade
      // itself is what does that, while still mounted); a short buffer past
      // this tick is still enough for the last frame's paint to land.
      setTimeout(() => URL.revokeObjectURL(url), 200);
    };
  });

  // Playback intent. The element is the source of truth for *where* we are; this
  // only ever says whether it should be running.
  $effect(() => {
    const v = el;
    if (!v || !src) return;
    if (wantPlaying) void play(v);
    else v.pause();
  });

  /**
   * The last seek this page has carried out, and the clip it belonged to. Not
   * reactive: it's a record of what's been done, and writing it must not re-run
   * the effect that writes it.
   */
  let applied = { generation: -1, token: -1 };

  // Scrubbing, from the tile on the operator's screen. A clip arriving is not a
  // seek — the first sight of a new generation only adopts its token — so
  // reloading the element never replays the previous clip's scrub position.
  $effect(() => {
    const v = el;
    const g = generation;
    const token = seekToken;
    const at = seekPosition;
    if (!v || !src) return;
    if (applied.generation !== g) {
      applied = { generation: g, token };
      return;
    }
    if (applied.token === token) return;
    applied = { generation: g, token };
    v.currentTime = at;
  });

  /**
   * Volume, picture opacity, trim, and loop, driven straight off the element's
   * own clock every frame — the same clock the position readout below already
   * samples — rather than wall-clock timers. That makes fades naturally hold
   * still while paused (currentTime isn't moving) and resume exactly where
   * they left off, with no separate pause bookkeeping needed. It also folds
   * the once-per-loaded-clip concern (fade in only the first pass, not every
   * repeat) into a single counter alongside everything else this loop already
   * tracks per clip.
   *
   * The picture fades in lockstep with the sound — one `fadeFactor`, applied
   * to both — rather than the mount/unmount transition a fixed-duration pop
   * used to give every clip regardless of its own settings. A cue with no
   * fade configured now cuts instantly, sound and picture together, matching
   * what an unfaded audio cue does.
   *
   * Reads `view.*` directly rather than through the `$derived`s above: those
   * exist to gate *effects* (reloading the element, etc.) from firing on every
   * push, but a plain read inside this callback always sees the latest value
   * with no such concern.
   *
   * Report the element's real state back while a clip is up. The opener is the
   * authority on the show, but this window holds the only thing that knows where
   * the clip actually is — so it feeds that back every frame, and the launchpad
   * tile on the operator's screen reads live off it.
   */
  $effect(() => {
    const v = el;
    if (!v || !src) return;
    const clipGeneration = generation;
    // How close to the out point counts as "there" — one frame's worth of
    // native `timeupdate` jitter, not a hard equality check.
    const EPS = 0.05;
    let loopIndex = 0;
    let endedFired = false;
    let raf = 0;
    let last: VideoStatus | null = null;
    const tick = () => {
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const effectiveEnd = view.endTime ?? dur;
      const t = v.currentTime;

      if (dur > 0 && effectiveEnd > 0 && t >= effectiveEnd - EPS) {
        if (view.loop) {
          v.currentTime = view.startTime;
          loopIndex++;
        } else if (view.endTime != null && !endedFired && !v.paused) {
          // Only an explicit trim ends the clip early; with no endTime this
          // defers to the element's own `ended` event at the real end of file,
          // unchanged from before trimming existed.
          endedFired = true;
          v.pause();
          onended(clipGeneration);
        }
      }

      let fadeFactor = 1;
      if (loopIndex === 0 && view.fadeIn > 0) {
        fadeFactor = Math.min(1, Math.max(0, (t - view.startTime) / view.fadeIn));
      }
      if (!view.loop && view.fadeOutOnEnd && view.fadeOut > 0 && effectiveEnd > 0) {
        const toEnd = effectiveEnd - t;
        if (toEnd < view.fadeOut) fadeFactor = Math.min(fadeFactor, Math.max(0, toEnd / view.fadeOut));
      }
      fadeFactor = Math.min(1, Math.max(0, fadeFactor));
      const base = view.muted || forcedMute ? 0 : Math.min(1, Math.max(0, view.volume));
      v.volume = base * fadeFactor;
      opacity = fadeFactor;

      const status: VideoStatus = {
        position: t,
        duration: dur,
        playing: !v.paused && !v.ended,
      };
      // A paused clip's readout doesn't change; skip the identical pushes rather
      // than waking the opener's reactivity for nothing.
      if (
        !last ||
        last.position !== status.position ||
        last.duration !== status.duration ||
        last.playing !== status.playing
      ) {
        last = status;
        onprogress(clipGeneration, status);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  async function play(v: HTMLVideoElement): Promise<void> {
    try {
      await v.play();
      blocked = false;
    } catch {
      // Autoplay policy: the click that fired the cue happened in the opener, so
      // this window may have no user activation of its own and a clip with sound
      // can be refused outright. Muted playback is always allowed — better a
      // silent picture than a black screen, with a prompt to restore the sound.
      forcedMute = true;
      try {
        await v.play();
        blocked = !view.muted;
      } catch {
        blocked = true;
      }
    }
  }

  /** Clicking the screen is the user activation that lets the sound back on. */
  function unblock() {
    if (!blocked || !el) return;
    forcedMute = false;
    blocked = false;
    void el.play().catch(() => (blocked = true));
  }
</script>

{#if src}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="stage" onclick={unblock}>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={el}
      {src}
      style:object-fit={view.fit}
      style:opacity={opacity}
      muted={view.muted || forcedMute}
      playsinline
      onloadedmetadata={onLoadedMetadata}
      onended={() => onended(view.generation)}
    ></video>
    {#if blocked}
      <div class="blocked">Click to unmute</div>
    {/if}
  </div>
{/if}

<style>
  .stage {
    position: absolute;
    inset: 0;
    background: #000;
  }
  video {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
  }
  .blocked {
    position: absolute;
    right: 2vh;
    bottom: 2vh;
    padding: 0.8vh 1.4vh;
    border-radius: 0.8vh;
    font-family: 'Bahnschrift', system-ui, sans-serif;
    font-size: 2vh;
    color: #fff;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.25);
    cursor: pointer;
  }
</style>
