// Worker wrapper around the BS.1770 loudness measurement. Analysing a track is
// tens of milliseconds of tight numeric loops per minute of audio; running it
// here keeps the UI responsive while a folder full of cues loads, and lets the
// pool measure several files at once across cores.

import { measureNormalizeGain, type LoudnessRequest, type LoudnessResponse } from './loudness';

self.onmessage = (e: MessageEvent<LoudnessRequest>) => {
  const { id, channels, sampleRate } = e.data;
  let gain = 1;
  try {
    gain = measureNormalizeGain(channels, sampleRate);
  } catch {
    // A measurement failure should never block playback — fall back to unity.
  }
  const res: LoudnessResponse = { id, gain };
  self.postMessage(res);
};
