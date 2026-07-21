<script lang="ts">
  import { app } from '../state/project.svelte';
  import { cueDrag } from './cueDrag.svelte';
  import { formatTime } from '../timer/timer';
  import type { Cue } from '../types';
  import CueHints from './CueHints.svelte';
  import type { Component } from 'svelte';
  import IconProxy from '~icons/bi/arrow-left-right';
  import IconStopwatchFill from '~icons/bi/stopwatch-fill';
  import IconPlayFill from '~icons/bi/play-fill';
  import IconGlobalAll from '~icons/bi/collection-fill';
  import IconGlobalOne from '~icons/bi/file-earmark-fill';
  import { cubicOut } from 'svelte/easing';
  import { Tween } from 'svelte/motion';
  import {
    bandPath,
    COMMIT_TIME,
    fillFor,
    sweepPath,
    wedgePath,
    wedgeWorthDrawing,
    type Direction,
  } from './cueFill';

  let { cue }: { cue: Cue } = $props();

  let info = $derived(app.display(cue));
  let flash = $derived(app.httpFlashes[cue.id]);
  let active = $derived(info.state !== 'idle');
  // Resolve to the real cue (self, or a proxy's source) to read its live state.
  let target = $derived(app.resolveProxy(cue));
  let audioTarget = $derived(target?.type === 'audio' ? target : null);
  let videoTarget = $derived(target?.type === 'video' ? target : null);
  let timerTarget = $derived(target?.type === 'timer' ? target : null);

  /**
   * How long the fade in progress has in it, from the playback rather than the
   * cue — an end-of-clip fade is cut to the audio that's left. Only audio fades
   * at all; everything else cuts.
   */
  let fadeSeconds = $derived(audioTarget ? app.fadeSeconds(audioTarget) : 0);

  /**
   * How much of the tile is coloured in, and along what slope. This is the whole
   * state readout: empty is idle, solid is playing, and a wedge filling along
   * the foot is a fade with its slope pointing the way it's going.
   */
  let fill = $derived(
    fillFor(info.state, audioTarget ? app.fadeProgress(audioTarget) : 1, fadeSeconds),
  );

  /**
   * The commit, tweened here rather than by a CSS transition on the clip-path.
   *
   * Its length is not a look, it is a term in the fill maths: the fade-out holds
   * its wedge full for exactly this long, and the fade-in fills its wedge
   * exactly this early, both so the two shapes hand over cleanly. A duration
   * sitting in a stylesheet is one nobody can see from there, and the two drifted
   * apart the moment either was tuned. Tweening from the same constant leaves
   * one definition.
   *
   * Started at whatever the cue is already doing, so a tile that mounts on a
   * playing cue — switching tabs, opening a second file — is solid immediately
   * rather than committing to something that started without it.
   */
  // svelte-ignore state_referenced_locally -- the initial value is the point:
  // where the tween starts, not something it should follow.
  const band = new Tween(fillFor(info.state, 1, 0).band, {
    duration: COMMIT_TIME * 1000,
    easing: cubicOut,
  });
  $effect(() => {
    band.target = fill.band;
  });

  /**
   * Whether a wedge is being drawn at all: a fade the tile is showing as one.
   * A cut isn't, and neither is a fade shorter than the commit animation — both
   * of those are the band on its own. The state test is not redundant with the
   * time: a cue that has *finished* a long fade-in still reports that fade's
   * length, and it is not fading any more.
   */
  let fading = $derived(
    (info.state === 'fadingIn' || info.state === 'fadingOut') && wedgeWorthDrawing(fadeSeconds),
  );

  /**
   * Which way the wedge leans — the last fade's lean, held through the states
   * either side of it.
   *
   * A fade-out ends by handing over to idle, and the ghost wedge is still on
   * screen at that moment: it has its own 100ms to fade away. Taking the
   * direction straight from the current state flipped the wedge under it as it
   * went, so the last thing a stopping cue did was appear to reverse. Holding
   * the lean means the flip only ever happens while the wedge is invisible —
   * under a full band on the way into a fade-out, at zero opacity on the way
   * into a fade-in.
   */
  let lastFadeDirection = $state<Direction>('up');
  $effect(() => {
    if (fading) lastFadeDirection = fill.direction;
  });
  // Read live while fading, so a fade never waits a frame for its own slope.
  let direction = $derived(fading ? fill.direction : lastFadeDirection);

  /**
   * Audio glows with its own output loudness. Nothing else can: a clip plays on
   * the other screen — measuring it would mean routing that window's sound
   * through an AudioContext just to light a tile over here — and a countdown
   * has no output to measure at all. Both get a steady glow instead: enough to
   * read as live across the room, with the scrub bar carrying the detail.
   *
   * Held is the one distinction worth drawing. A paused clip or a paused clock
   * is still up in front of the audience but isn't going anywhere, so it gets
   * the ring without the pull of a full glow.
   */
  const STEADY_GLOW = 0.4;
  let glow = $derived(
    !active
      ? 0
      : audioTarget
        ? app.level(audioTarget)
        : videoTarget
          ? app.videoStatus.playing
            ? STEADY_GLOW
            : STEADY_GLOW / 3
          : timerTarget
            ? app.timer.running
              ? STEADY_GLOW
              : STEADY_GLOW / 3
            : 0,
  );

  // ---- Scrubbing ---------------------------------------------------------

  /** Length of whatever this tile is playing, in seconds; 0 if not scrubbable. */
  let length = $derived(
    !active
      ? 0
      : audioTarget
        ? app.duration(audioTarget)
        : videoTarget
          ? app.videoStatus.duration
          : timerTarget
            ? app.timer.duration
            : 0,
  );
  /**
   * Playhead position, 0..1. The countdown moves in 200ms steps rather than per
   * frame, which is the rate it is counted at — and at the lengths a show timer
   * is set for, a bar that advanced smoothly would be advancing invisibly.
   */
  let played = $derived(
    length <= 0
      ? 0
      : audioTarget
        ? app.progress(audioTarget)
        : videoTarget
          ? app.videoProgressFraction
          : app.timerProgressFraction,
  );
  let seekable = $derived(length > 0);
  let scrubbing = $state(false);

  function seekTo(e: PointerEvent): void {
    const rail = e.currentTarget as HTMLElement;
    const box = rail.getBoundingClientRect();
    if (box.width <= 0) return;
    const f = (e.clientX - box.left) / box.width;
    if (audioTarget) app.seekTo(audioTarget, f);
    else if (videoTarget) app.seekVideo(f);
    else if (timerTarget) app.seekTimer(f);
  }

  function scrubStart(e: PointerEvent): void {
    // The tile underneath is a transport button and a drag source; neither
    // should hear about a press that lands on the scrub bar.
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubbing = true;
    seekTo(e);
  }

  function scrubMove(e: PointerEvent): void {
    if (scrubbing) seekTo(e);
  }

  function scrubEnd(e: PointerEvent): void {
    e.stopPropagation();
    scrubbing = false;
  }

  // ---- Trigger hints -----------------------------------------------------

  // What the hovered tile's triggers would do to this one — empty unless some
  // other tile is hovered and drives this one.
  let hints = $derived(app.previewTargets.get(cue.id) ?? []);
  // Blue when this click sets it off, grey when it happens later on.
  let hintNow = $derived(hints.some((h) => h.now));
  let isHovered = $derived(app.hoveredCueId === cue.id);

  // ---- Labels ------------------------------------------------------------

  /** What a tile says when the cue has no name of its own. */
  const DEFAULT_LABELS: Partial<Record<Cue['type'], string>> = {
    http: 'HTTP',
    timer: 'Timer',
    video: 'Video',
    global: 'All',
  };

  /** Bare file name of a clip, without its folder path or extension. */
  function clipName(file: string): string {
    if (!file) return '(no clip)';
    return file.split('/').pop()!.replace(/\.[^.]+$/, '');
  }

  /** Host of an HTTP cue's URL, or the raw string if it won't parse. */
  function host(url: string): string {
    if (!url) return '(no url)';
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  /**
   * The tile's second line: what kind of cue this is at rest, and how much of it
   * is left once it's running.
   *
   * A live cue trades its description for its remaining time on purpose. The
   * fill already says *that* it's playing — repeating the word there would be
   * the one thing on a running tile carrying no information — while the number
   * an operator is actually waiting on has nowhere else to live.
   */
  function subtitle(): { icon: Component | null; text: string } {
    if (info.missing) return { icon: null, text: 'media missing' };
    if (info.pending) return { icon: null, text: 'loading…' };
    if (info.unavailable) return { icon: null, text: 'no screen' };
    if (active && length > 0) {
      return { icon: null, text: `−${formatTime(Math.max(0, length * (1 - played)))}` };
    }

    switch (cue.type) {
      case 'audio': {
        const secs = app.duration(cue);
        return { icon: null, text: secs > 0 ? formatTime(secs) : 'audio' };
      }
      case 'proxy':
        return {
          icon: IconProxy,
          text: target && target.type !== 'proxy' ? app.display(target).name || 'audio' : 'nothing',
        };
      case 'timer':
        return { icon: IconStopwatchFill, text: cue.action === 'set' ? formatTime(cue.duration) : cue.action };
      case 'video':
        return { icon: IconPlayFill, text: cue.action === 'play' ? clipName(cue.file) : cue.action };
      case 'global':
        // Scope first: reaching into other cue files is the surprising part.
        return {
          icon: cue.scope === 'all' ? IconGlobalAll : IconGlobalOne,
          text: `${cue.scope === 'all' ? 'every file ' : ''}${cue.action}${cue.fade ? '' : ' · cut'}`,
        };
      case 'http':
        return { icon: null, text: `${cue.method} ${host(cue.url)}` };
    }
  }

  function stateTitle(): string {
    if (info.state === 'fadingIn') return `${info.name} — click to bring it up to full now`;
    if (info.state === 'fadingOut') return `${info.name} — click to cut it out now`;
    return info.name;
  }

  /** The one line the tile's tooltip shows, most blocking reason first. */
  function title(): string {
    if (info.missing) return 'Media missing';
    if (info.unavailable) return info.unavailable;
    if (info.pending) return 'Loading media…';
    return stateTitle();
  }

  function onClick(e: MouseEvent) {
    if (e.shiftKey) {
      // Shift-click: open properties.
      app.openProperties(cue.id);
      return;
    }
    app.activate(cue);
  }

  // Alt picks the tile up to move it, Ctrl to copy it. Everything about the
  // gesture lives in cueDrag; the tile only offers it the press.
  function onPointerDown(e: PointerEvent) {
    cueDrag.press(cue.id, e);
  }

</script>

<!--
  The tile's text is rendered twice: once on the resting card, once inside the
  fill, clipped to exactly the same wedge. The two are pixel-aligned, so as the
  colour sweeps across, every glyph it passes flips to its readable-on-colour
  version at the moment the edge crosses it — no fading text, and no compromise
  colour that has to survive both grounds.
-->
{#snippet face()}
  <!-- A proxy borrows its source's name, colour and state, so once it's running
       there is nothing left to tell the two tiles apart — and they are not the
       same: clicking this one stops a cue somewhere else. The mark is the only
       thing on the tile that stays put in every state, because that difference
       doesn't go away when the cue starts. -->
  {#if cue.type === 'proxy'}<span class="mark" aria-hidden="true"><IconProxy /></span>{/if}
  <span class="title">{info.name || DEFAULT_LABELS[cue.type] || '—'}</span>
  {@const sub = subtitle()}
  {@const SubIcon = sub.icon}
  <span class="sub">{#if SubIcon}<SubIcon />{/if}{sub.text}</span>
{/snippet}

<!--
  The wrapper fills the whole grid cell, including the space that reads as the
  gap between tiles, and carries hover, click and the drag — Fitts's law: the
  gap is dead pixels the pointer has to cross, so every one belongs to the
  nearest cue. The drag can sit out here now that it's a pointer gesture; under
  native DnD it had to stay on the visible tile, because a modified press on a
  non-draggable wrapper is a selection gesture the browser swallows.
-->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="hit"
  onclick={onClick}
  onpointerdown={onPointerDown}
  onmouseenter={() => (app.hoveredCueId = cue.id)}
  onmouseleave={() => {
    if (app.hoveredCueId === cue.id) app.hoveredCueId = null;
  }}
  class:unavailable={!!info.unavailable}
  title={title()}
>
  <button
    class="cue"
    class:lifted={cueDrag.id === cue.id}
    class:active
    class:selected={app.propertiesCueId === cue.id}
    class:missing={info.missing}
    class:pending={info.pending}
    class:unavailable={!!info.unavailable}
    class:targeted={hints.length > 0}
    class:now={hintNow}
    class:hovering={isHovered}
    style:--cue-color={info.color}
    style:--glow={glow}
    style:--commit="{COMMIT_TIME}s"
  >
    <span class="layer rest">{@render face()}</span>

    <!-- The track the fade fills along: the wedge it is heading for, drawn
         empty. Without it the sweep is a shape that grows, and a shape that
         grows carries no sense of how much is left. Always present so it can
         fade in and out with the fade itself rather than popping. -->
    <span class="wedge ghost" class:showing={fading} style:clip-path={wedgePath(direction)}></span>

    <!-- The swept part of the wedge. Two nested clips, which intersect: the
         wedge's own outline, and how far along it the fade has got.

         Shown only while a fade is being drawn, for the same reason as the
         track behind it. A playing cue keeps its wedge fully swept underneath
         the band, so a fade-out has a full one to collapse onto — but with the
         band mid-rise it isn't fully underneath anything, and left visible it
         put a triangle on screen for the 100ms of every cut. -->
    <span class="wedge" class:showing={fading} style:clip-path={wedgePath(direction)}>
      <span class="sweep" style:clip-path={sweepPath(fill.progress, direction)}>
        <span class="layer filled">{@render face()}</span>
      </span>
    </span>

    <!-- Live: the whole card. Rises over the wedge and falls back through it. -->
    <span class="band" style:clip-path={bandPath(band.current)}>
      <span class="layer filled">{@render face()}</span>
    </span>

    {#if seekable}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="scrub"
        class:scrubbing
        style:--played={played}
        onpointerdown={scrubStart}
        onpointermove={scrubMove}
        onpointerup={scrubEnd}
        onpointercancel={scrubEnd}
        onclick={(e) => e.stopPropagation()}
        ondragstart={(e) => e.preventDefault()}
        title="Drag to scrub"
      >
        <span class="rail"><span class="elapsed"></span></span>
        <span class="knob"></span>
      </span>
    {/if}

    <CueHints {hints} />

    {#if flash}
      {#key flash.at}
        <span class="flash flash-{flash.state}"></span>
      {/key}
    {/if}
  </button>
</div>

<style>
  /* The hit area: the entire cell. Its padding is half the visual gap, so
     neighbouring hit areas meet exactly in the middle of the gap and no pixel
     of the grid is dead. */
  .hit {
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: calc(var(--tile-gap, 8px) / 2);
    cursor: pointer;
    /* Nothing in a tile is worth selecting, and a stray selection here fights
       the drag gesture. */
    user-select: none;
    -webkit-user-select: none;
  }

  /* The resting card. Its own colour is present but held right back — enough to
     tell two tiles apart at a glance, nowhere near enough to be mistaken for
     the solid fill that means "this is live". */
  .cue {
    /* Every shade a tile uses is derived from the cue's colour by *replacing*
       its lightness, in OKLCH, keeping only hue and chroma. Two consequences,
       both wanted:

       - A state looks the same weight on every cue. Taking the colour as given
         made a pale yellow cue shout at rest and a navy one vanish when live;
         pinning L per state means "filled" is exactly as loud whatever hue the
         operator picked, and the colour is left doing the one job it's good at,
         which is telling cues apart.
       - The text contrast is decided here rather than measured per cue. The
         fill never leaves the light end of the scale, so ink on it is always
         the dark one — no luminance maths, and no cue that lands near the
         threshold and flips.

       OKLCH rather than HSL because its L is perceptually even: HSL 50% yellow
       and HSL 50% blue are nowhere near the same brightness, which is the exact
       problem this is here to solve. */
    --tint: oklch(from var(--cue-color) 0.245 calc(c * 0.55) h);
    --edge: oklch(from var(--cue-color) 0.4 calc(c * 0.7) h);
    --edge-hot: oklch(from var(--cue-color) 0.65 c h);
    /* Live. Held to a narrow band near the top of the scale — the cue's own
       lightness nudges it, but can't take it out of the range where dark ink
       reads. */
    --fill: oklch(from var(--cue-color) calc(0.72 + l * 0.1) c h);
    --ink: #0e0f13;
    --halo: oklch(from var(--cue-color) 0.7 c h / 0.6);
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    border-radius: 10px;
    border: 1px solid var(--edge);
    background: var(--tint);
    overflow: hidden;
    transition:
      box-shadow 0.07s linear,
      border-color 0.12s ease;
  }

  /* Both copies of the text sit in the same place; only their ground differs. */
  .layer {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 6px;
    text-align: center;
  }
  /* Make room for the scrub bar rather than letting it sit over the time it is
     scrubbing. Applied to both copies of the text, so they stay aligned. */
  .cue.active .layer {
    padding-bottom: 20px;
  }
  .rest {
    color: var(--text);
  }
  /* Named for what it is rather than for the state it represents. The obvious
     name here is `.on`, and it was: it then also matched the hint rows' own
     `.on` modifier further down, which handed every active trigger row the cue's
     fill colour as a background. Svelte scopes styles per component, not per
     subtree, so two unrelated meanings of one class name inside one file collide
     silently — and this file has two independent little state machines in it. */
  .filled {
    background: var(--fill);
    color: var(--ink);
  }
  .wedge,
  .sweep,
  .band {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  /* The band's own rise and fall is tweened in the script, not here — see the
     `band` Tween. The sweep across the wedge takes no transition at all: it is
     redrawn every frame off the audio clock, so easing it would only add lag to
     a value that is already smooth, and it never jumps, because a playing cue
     keeps its wedge fully swept underneath the band. */
  /* Neither wedge is drawn except while a fade is being drawn as one. The two
     appear and leave at different moments, though, which is why this is a pair
     of asymmetric transitions rather than one fade either way:

     - Appearing is instant. A fade-out's wedge has to be *there*, full, for the
       band to land on as it collapses over it; cross-fading it in over those
       same 100ms would leave the handover looking like neither shape.
     - Leaving takes the commit's own 100ms. A fade-in ends by handing over to a
       band that starts at nothing, and a wedge that vanished on the same frame
       would empty the tile before the band had filled it.

     The ghost's own opacity follows below and must keep winning: it is the
     track, not the fill, and it is never fully opaque. */
  .wedge {
    opacity: 0;
    transition: opacity var(--commit) ease-out;
  }
  .wedge.showing {
    opacity: 1;
    transition: none;
  }
  /* The unfilled wedge. Same colour as the fill, held far enough back to read
     as the space the fill has yet to reach rather than as fill itself. Unlike
     the filled wedge it does fade in: it is the empty track arriving, and it has
     nothing to hand over to or from. */
  .ghost {
    background: var(--fill);
    opacity: 0;
    transition: opacity var(--commit) ease-out;
  }
  .ghost.showing {
    opacity: 0.22;
    transition: opacity var(--commit) ease-out;
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.15;
    word-break: break-word;
  }
  /* Inside the faces, so the fill sweep repaints it along with the text rather
     than leaving it stranded on the wrong ground. */
  .mark {
    position: absolute;
    top: 4px;
    left: 5px;
    font-size: 10px;
    line-height: 1;
    opacity: 0.7;
  }
  .sub {
    font-size: 10px;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    opacity: 0.62;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub :global(svg) {
    margin-right: 3px;
  }

  /* Keyed off the hit area, not the tile — hovering the gap has to light the
     tile, which is the whole point of extending the target. */
  .hit:hover .cue,
  .cue:focus-visible {
    border-color: var(--edge-hot);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28);
  }
  .cue.active {
    /* Spread tracks the live output loudness (--glow 0..1), so a tile breathes
       with what it is putting out. */
    box-shadow: 0 0 calc(6px + var(--glow, 0) * 34px) var(--halo);
  }
  .hit:hover .cue.active {
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.28),
      0 0 calc(6px + var(--glow, 0) * 34px) var(--halo);
  }
  /* The tile is being carried: the copy under the pointer is the live one, and
     this is the hole it came out of. */
  .cue.lifted {
    opacity: 0.35;
  }
  .cue.selected {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }
  .cue.missing {
    border-style: dashed;
    border-color: var(--danger);
  }
  /* Still decoding: the cue isn't broken, just not ready yet. Static — the
     "loading" line already says it's working, and a pulse would add motion the
     eye keeps checking without learning anything from. */
  .cue.pending {
    opacity: 0.55;
  }
  /* Nothing wrong with the cue — it just has nowhere to run right now. Drained
     of colour rather than dimmed, so it reads as "not available" instead of
     "still loading", and the pointer says the click won't do anything. */
  .cue.unavailable {
    filter: saturate(0.1);
    opacity: 0.6;
  }
  .hit.unavailable {
    cursor: not-allowed;
  }

  /* The scrub bar. Pinned across the foot of the tile with its own ground, so
     it reads the same whether the fill has reached it or not — it is the one
     control here that must stay legible in every state. */
  .scrub {
    position: absolute;
    left: 5px;
    right: 5px;
    bottom: 4px;
    height: 12px;
    display: flex;
    align-items: center;
    cursor: ew-resize;
    touch-action: none;
  }
  .rail {
    position: relative;
    flex: 1;
    height: 8px;
    border-radius: 4px;
    background: rgba(8, 10, 14, 0.45);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
    overflow: hidden;
  }
  .elapsed {
    position: absolute;
    inset: 0;
    transform-origin: left center;
    transform: scaleX(var(--played, 0));
    background: rgba(255, 255, 255, 0.55);
  }
  /* Sized and inset so the knob's travel stops at the rail's ends rather than
     hanging off them. */
  .knob {
    position: absolute;
    top: 50%;
    left: calc(6px + var(--played, 0) * (100% - 12px));
    width: 12px;
    height: 12px;
    margin-left: -6px;
    margin-top: -6px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 0 0 1px rgba(8, 10, 14, 0.6);
    pointer-events: none;
  }
  .scrub:hover .knob,
  .scrub.scrubbing .knob {
    box-shadow:
      0 0 0 1px rgba(8, 10, 14, 0.6),
      0 0 0 4px rgba(255, 255, 255, 0.22);
  }

  /* Hovering a cue marks up every tile it drives. Nothing shows at rest, so the
     grid stays clean and the badges can afford to be legible when they do
     appear. Colour carries the timing: blue for what this click fires, faded
     grey for what happens later in the hovered cue's life. */
  /* Drawn as a pseudo-element border rather than box-shadow or outline: a
     targeted cue may also be playing (box-shadow carries the level glow) or
     selected (outline), and this must never take either of those away. */
  /* The ring is always present but transparent, so adding .targeted fades it in
     over the same 120ms as the badges. Creating the pseudo-element only when
     targeted would give the transition nothing to start from, and it would pop. */
  .cue::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease;
    /* Two-tone ring: a light line backed by a darker one. Any single colour
       fails on some cue — the accent disappeared on audio cues, which default
       to the same blue — but a light/dark pair keeps contrast on every hue,
       so it can stay faint without ever vanishing. */
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.1),
      inset 0 0 0 2px rgba(0, 0, 0, 0.1);
  }
  .cue.targeted::after {
    opacity: 1;
  }
  /* Imminent: thicker and brighter, tinted just enough to keep the blue
     association the badges carry, without relying on hue to be seen. */
  .cue.targeted.now::after {
    box-shadow:
      inset 0 0 0 2px rgba(219, 234, 254, 0.3),
      inset 0 0 0 3px rgba(0, 0, 0, 0.3);
  }

  .flash {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .flash-ok {
    animation: flashfade 0.6s ease-out;
    background: var(--ok);
  }
  .flash-error {
    animation: flashfade 0.6s ease-out;
    background: var(--danger);
  }
  .flash-firing {
    background: rgba(255, 255, 255, 0.25);
  }
  @keyframes flashfade {
    from {
      opacity: 0.75;
    }
    to {
      opacity: 0;
    }
  }
</style>
