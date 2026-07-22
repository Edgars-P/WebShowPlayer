<script lang="ts">
  // Renders nothing. It exists to bridge the player's runes reactivity to the
  // imperative "send a snapshot" call: a single $effect reads the state a phone
  // needs, folds it into a RemoteSnapshot, and hands it to the host, which
  // throttles the actual network send. Mounting an invisible effect-owner like
  // this is the idiomatic Svelte way to react to state from outside a component
  // tree, and it keeps all the app-reading in one place.
  //
  // Costs nothing until a phone is actually connected: the effect bails before
  // touching any player state unless the remote is on and a peer is present.

  import { app } from '../state/project.svelte';
  import type { CueDisplay } from '../state/project.svelte';
  import { remoteHost } from '../remote/remoteHost.svelte';
  import { buildSnapshot, type RemoteCue, type SnapshotInput, type SubtitleIcon } from '../remote/protocol';
  import { formatTime } from '../timer/timer';
  import type { Cue } from '../types';

  /** Bare clip name, without folder path or extension. */
  function clipName(file: string): string {
    if (!file) return '(no clip)';
    return file.split('/').pop()!.replace(/\.[^.]+$/, '');
  }

  /** Host of an HTTP cue's URL, or the raw string if it won't parse. */
  function urlHost(url: string): string {
    if (!url) return '(no url)';
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  /**
   * Fade-in/out durations the phone needs to predict whether tapping a cue
   * lands on fadingIn/fadingOut or snaps straight to playing/idle (see
   * optimistic.ts). Only audio cues (direct, or via a proxy) have a fade.
   */
  function fadeTimes(cue: Cue): { fadeInSec: number; fadeOutSec: number } {
    const target = cue.type === 'proxy' ? app.resolveProxy(cue) : cue;
    if (target && target.type === 'audio') return { fadeInSec: target.fadeIn, fadeOutSec: target.fadeOut };
    return { fadeInSec: 0, fadeOutSec: 0 };
  }

  /**
   * The cue's second line, mirroring CueButton.subtitle: a live cue shows its
   * remaining time, an idle one shows what kind of cue it is. The icon is sent
   * as a key, not a glyph — the phone picks its own icon for it, same as the
   * host does for CueButton (see `SubtitleIcon` in protocol.ts).
   */
  function subtitleFor(cue: Cue, info: CueDisplay): { icon: SubtitleIcon; text: string } {
    if (info.missing) return { icon: null, text: 'media missing' };
    if (info.pending) return { icon: null, text: 'loading…' };
    if (info.unavailable) return { icon: null, text: 'no screen' };

    if (info.state !== 'idle') {
      if (cue.type === 'audio') {
        const r = app.remaining(cue);
        if (r > 0) return { icon: null, text: `−${formatTime(r)}` };
      } else if (cue.type === 'proxy') {
        const t = app.resolveProxy(cue);
        if (t && t.type === 'audio') {
          const r = app.remaining(t);
          if (r > 0) return { icon: null, text: `−${formatTime(r)}` };
        }
      } else if (cue.type === 'video') {
        const { duration, position } = app.videoStatus;
        if (duration > 0) return { icon: null, text: `−${formatTime(Math.max(0, duration - position))}` };
      } else if (cue.type === 'timer') {
        if (app.timer.duration > 0) return { icon: null, text: `−${formatTime(app.timer.remaining)}` };
      }
    }

    switch (cue.type) {
      case 'audio': {
        const secs = app.duration(cue);
        return { icon: null, text: secs > 0 ? formatTime(secs) : 'audio' };
      }
      case 'proxy': {
        const t = app.resolveProxy(cue);
        return { icon: 'proxy', text: t && t.type !== 'proxy' ? app.display(t).name || 'audio' : 'nothing' };
      }
      case 'timer':
        return { icon: 'timer', text: cue.action === 'set' ? formatTime(cue.duration) : cue.action };
      case 'video':
        return { icon: 'video', text: cue.action === 'play' ? clipName(cue.file) : cue.action };
      case 'global':
        return {
          icon: cue.scope === 'all' ? 'globalAll' : 'globalOne',
          text: `${cue.scope === 'all' ? 'every file ' : ''}${cue.action}${cue.fade ? '' : ' · cut'}`,
        };
      case 'http':
        return { icon: null, text: `${cue.method} ${urlHost(cue.url)}` };
    }
  }

  $effect(() => {
    // No work — and, crucially, no relay traffic — until the remote is on and a
    // phone is watching. Reading these two runes first also means the effect
    // re-runs (and starts tracking player state) the moment a phone connects.
    if (!remoteHost.enabled || remoteHost.peerCount === 0) return;

    const doc = app.activeDoc;
    const project = app.project;

    // Tabs only exist when a document is open; with none, we still push a
    // snapshot (empty cue list) so the phone reflects "no show open" rather than
    // freezing on a document that was just closed. The global slots (timer,
    // video, screen) are read either way — they can outlive their document.
    const tabs =
      doc && project
        ? project.tabs.map((tab) => ({
            id: tab.id,
            name: tab.name,
            cues: tab.cues.map((cue): RemoteCue => {
              const info = app.display(cue);
              const sub = subtitleFor(cue, info);
              const fade = fadeTimes(cue);
              return {
                id: cue.id,
                name: info.name,
                color: info.color,
                state: info.state,
                missing: info.missing,
                pending: info.pending,
                unavailable: !!info.unavailable,
                subtitle: sub.text,
                subtitleIcon: sub.icon,
                row: cue.row,
                col: cue.col,
                fadeInSec: fade.fadeInSec,
                fadeOutSec: fade.fadeOutSec,
              };
            }),
          }))
        : [];

    const { duration, position } = app.videoStatus;
    const input: SnapshotInput = {
      docs: app.docs.map((d) => ({ id: d.id, title: d.title })),
      activeDocId: doc?.id ?? '',
      activeTabId: app.activeTabId,
      master: project?.masterVolume ?? 1,
      screenLive: app.screenLive,
      anyPlaying: app.anyPlaying,
      timer: {
        duration: app.timer.duration,
        remaining: app.timer.remaining,
        running: app.timer.running,
        finished: app.timer.finished,
      },
      video: {
        active: app.videoActive,
        playing: app.videoStatus.playing,
        remaining: duration > 0 ? Math.max(0, duration - position) : 0,
      },
      tabs,
    };

    remoteHost.pushState(buildSnapshot(input));
  });
</script>
