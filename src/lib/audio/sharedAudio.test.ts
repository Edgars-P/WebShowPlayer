// The shared buffer cache is what keeps several open documents from each
// holding their own copy of the same 20-MB-per-stereo-minute decode, so its
// dedup and refcounting are worth pinning down precisely.

import { beforeAll, describe, expect, it } from 'vitest';
import { installAudioStubs, STUB_BYTES } from '../test-utils/webAudioStub';

const stubs = installAudioStubs();

let audioCache: typeof import('./sharedAudio').audioCache;
let cacheKey: typeof import('./sharedAudio').cacheKey;

beforeAll(async () => {
  ({ audioCache, cacheKey } = await import('./sharedAudio'));
});

let reads = 0;
const load = async () => {
  reads++;
  return new ArrayBuffer(8);
};

describe('audioCache', () => {
  it('decodes a file once however many cues hold it', async () => {
    const key = cacheKey('folder-1', 'music/stinger.mp3');
    const before = stubs.decodes;
    reads = 0;

    await Promise.all(Array.from({ length: 10 }, () => audioCache.acquire(key, load)));

    expect(stubs.decodes - before).toBe(1);
    expect(reads).toBe(1);
    expect(audioCache.stats()).toEqual({ files: 1, bytes: STUB_BYTES });

    for (let i = 0; i < 10; i++) audioCache.release(key);
    expect(audioCache.get(key)).toBeNull();
  });

  it('shares one decode between two documents opening the same file', async () => {
    const key = cacheKey('folder-1', 'music/theme.mp3');
    const before = stubs.decodes;

    await audioCache.acquire(key, load); // document A
    await audioCache.acquire(key, load); // document B

    expect(stubs.decodes - before).toBe(1);

    // Closing A leaves the buffer resident for B...
    audioCache.release(key);
    expect(audioCache.get(key)).not.toBeNull();
    // ...and only the last release frees it.
    audioCache.release(key);
    expect(audioCache.get(key)).toBeNull();
  });

  it('keeps same-named files in different folders apart', async () => {
    const a = cacheKey('folder-1', 'intro.mp3');
    const b = cacheKey('folder-2', 'intro.mp3');
    const before = stubs.decodes;

    await audioCache.acquire(a, load);
    await audioCache.acquire(b, load);

    expect(stubs.decodes - before).toBe(2);
    expect(audioCache.stats().files).toBe(2);

    audioCache.release(a);
    audioCache.release(b);
  });

  it('does not retain a buffer released while it was still decoding', async () => {
    const key = cacheKey('folder-1', 'aborted.mp3');
    const pending = audioCache.acquire(key, load);
    audioCache.release(key); // e.g. the cue was deleted mid-load
    await pending;
    expect(audioCache.get(key)).toBeNull();
  });

  it('leaves no entry behind when a load fails, and allows a retry', async () => {
    const key = cacheKey('folder-1', 'missing.mp3');
    await expect(
      audioCache.acquire(key, async () => {
        throw new Error('no such file');
      }),
    ).rejects.toThrow('no such file');
    expect(audioCache.get(key)).toBeNull();

    await audioCache.acquire(key, load);
    expect(audioCache.get(key)).not.toBeNull();
    audioCache.release(key);
  });

  it('reports residency in bytes', async () => {
    const key = cacheKey('folder-9', 'one.mp3');
    await audioCache.acquire(key, load);
    const stats = audioCache.stats();
    expect(stats.files).toBe(1);
    expect(stats.bytes).toBe(STUB_BYTES);
    // One stereo minute at 44.1 kHz really is ~20 MB of float PCM.
    expect(STUB_BYTES / 1024 ** 2).toBeCloseTo(20.2, 1);
    audioCache.release(key);
    expect(audioCache.stats()).toEqual({ files: 0, bytes: 0 });
  });
});
