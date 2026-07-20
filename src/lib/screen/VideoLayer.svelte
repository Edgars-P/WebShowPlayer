<script lang="ts">
  // The video half of the projector screen. Owns the media element, and with it
  // the only authoritative playback position — the opener sets intent (which
  // clip, playing or not) and hears back only when the clip reaches its end.
  import { scale } from 'svelte/transition';
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

  /** Matches the timer's float, so the two swap as one movement. */
  const FLOAT_MS = 450;

  let el = $state<HTMLVideoElement | null>(null);
  let src = $state<string | null>(null);
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
  let volume = $derived(view.volume);
  let loop = $derived(view.loop);
  let seekToken = $derived(view.seekToken);
  let seekPosition = $derived(view.seekPosition);

  // One object URL per loaded clip. Keyed on `generation` as well as the File so
  // that re-firing the same clip mints a fresh URL and restarts it from zero,
  // rather than leaving the element parked on its last frame.
  $effect(() => {
    void generation;
    const clip = file;
    forcedMute = false;
    blocked = false;
    if (!clip) {
      src = null;
      return;
    }
    const url = URL.createObjectURL(clip);
    src = url;
    return () => {
      // Outlive the float-out: the element is still on screen and may still be
      // streaming from this URL while it shrinks away.
      setTimeout(() => URL.revokeObjectURL(url), FLOAT_MS + 500);
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

  // Volume and loop are plain properties, not attributes, so they're pushed
  // rather than bound. Re-applied on every change, including across clips.
  $effect(() => {
    const v = el;
    if (!v) return;
    v.volume = Math.min(1, Math.max(0, volume));
    v.loop = loop;
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

  // Report the element's real state back while a clip is up. The opener is the
  // authority on the show, but this window holds the only thing that knows where
  // the clip actually is — so it feeds that back every frame, and the launchpad
  // tile on the operator's screen reads live off it.
  $effect(() => {
    const v = el;
    if (!v || !src) return;
    const clipGeneration = generation;
    let raf = 0;
    let last: VideoStatus | null = null;
    const report = () => {
      const status: VideoStatus = {
        position: v.currentTime,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
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
      raf = requestAnimationFrame(report);
    };
    raf = requestAnimationFrame(report);
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
  <div
    class="stage"
    onclick={unblock}
    in:scale={{ duration: FLOAT_MS, start: 0.7 }}
    out:scale={{ duration: FLOAT_MS, start: 0.7 }}
  >
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={el}
      {src}
      style:object-fit={view.fit}
      muted={view.muted || forcedMute}
      playsinline
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
