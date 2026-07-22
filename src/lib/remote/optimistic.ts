// Locally-predictable effects of a RemoteCommand, applied on top of the
// host's last snapshot while a command is in flight, so the phone's UI can
// react to a tap instantly instead of waiting for the round trip. Deliberately
// conservative: only the tapped control's own field ever changes — never a
// neighbouring cue or cross-cue chain (trigger chains, global sweeps), since
// those are engine/show-configured behaviour the phone can't safely
// re-derive (see doc.svelte.ts's propagate/fireTriggers/runGlobalCue). Pure
// and framework-free so it's unit-testable in the `node` vitest environment,
// exactly like protocol.ts.

import type { RemoteCommand, RemoteCue, RemoteSnapshot, RemoteTab } from './protocol';

/**
 * Predict the effect of `cmd` on `snap`, or return null if this command type
 * isn't worth (or safe to) predicting — the caller should leave its working
 * snapshot unchanged in that case, not treat null as an error.
 */
export function predictSnapshot(snap: RemoteSnapshot, cmd: RemoteCommand): RemoteSnapshot | null {
  switch (cmd.t) {
    case 'activateCue':
      return predictActivateCue(snap, cmd.cueId);
    case 'stopAll':
      return predictStopAll(snap, cmd.fade);
    case 'timerPause':
      return snap.timer.active ? { ...snap, timer: { ...snap.timer, running: false } } : null;
    case 'timerResume':
      return snap.timer.active ? { ...snap, timer: { ...snap.timer, running: true } } : null;
    case 'timerClear':
      return { ...snap, timer: { ...snap.timer, active: false, running: false, finished: false } };
    case 'videoPause':
      return snap.video.active ? { ...snap, video: { ...snap.video, playing: false } } : null;
    case 'videoResume':
      return snap.video.active ? { ...snap, video: { ...snap.video, playing: true } } : null;
    case 'videoClear':
      return { ...snap, video: { ...snap.video, active: false, playing: false } };
    case 'openScreen':
      return snap.screenLive ? null : { ...snap, screenLive: true };
    case 'selectDoc':
      return cmd.docId === snap.activeDocId ? null : { ...snap, activeDocId: cmd.docId };
    case 'setTab':
    case 'setMaster':
      return null;
    default:
      return null;
  }
}

/**
 * The tapped cue's own toggle, matching AudioEngine.toggle() exactly: a tap
 * mid-fade-in snaps straight to full volume (never reverses into fading out),
 * and a tap mid-fade-out snaps straight to stopped (never resumes). Whether
 * idle/playing land on a fade or go straight to the opposite state depends on
 * whether the cue actually has a fade configured.
 */
function nextToggleState(cue: RemoteCue): RemoteCue['state'] {
  switch (cue.state) {
    case 'idle':
      return cue.fadeInSec > 0 ? 'fadingIn' : 'playing';
    case 'fadingIn':
      return 'playing';
    case 'playing':
      return cue.fadeOutSec > 0 ? 'fadingOut' : 'idle';
    case 'fadingOut':
      return 'idle';
  }
}

function predictActivateCue(snap: RemoteSnapshot, cueId: string): RemoteSnapshot | null {
  let found = false;
  let anyChanged = false;
  const tabs = snap.tabs.map((tab) => {
    let changed = false;
    const cues = tab.cues.map((cue): RemoteCue => {
      if (cue.id !== cueId) return cue;
      found = true;
      const next = nextToggleState(cue);
      if (next === cue.state) return cue;
      changed = true;
      return { ...cue, state: next };
    });
    if (changed) anyChanged = true;
    return changed ? { ...tab, cues } : tab;
  });
  if (!found || !anyChanged) return null;
  return { ...snap, tabs };
}

function predictStopAll(snap: RemoteSnapshot, fade: boolean): RemoteSnapshot {
  const tabs: RemoteTab[] = snap.tabs.map((tab) => ({
    ...tab,
    cues: tab.cues.map((cue) =>
      cue.state === 'playing' || cue.state === 'fadingIn'
        ? { ...cue, state: fade ? 'fadingOut' : 'idle' }
        : cue,
    ),
  }));
  return { ...snap, anyPlaying: false, tabs };
}
