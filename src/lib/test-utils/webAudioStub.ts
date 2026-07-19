// Minimal Web Audio + File System Access stubs for tests. The state and cache
// layers only need these APIs to exist and behave plausibly — nothing here
// makes sound, and decodeAudioData hands back a fixed-size buffer so byte
// accounting is predictable.

export const STUB_SECONDS = 60;
export const STUB_SAMPLE_RATE = 44100;
export const STUB_CHANNELS = 2;
/** Bytes one stubbed buffer occupies: 4-byte floats, per channel. */
export const STUB_BYTES = STUB_SAMPLE_RATE * STUB_SECONDS * STUB_CHANNELS * 4;

export interface StubCounters {
  decodes: number;
  reads: number;
}

class StubAudioBuffer {
  length = STUB_SAMPLE_RATE * STUB_SECONDS;
  numberOfChannels = STUB_CHANNELS;
  sampleRate = STUB_SAMPLE_RATE;
  duration = STUB_SECONDS;
  // Empty channels make loudness measurement short-circuit to unity gain, which
  // keeps these tests about plumbing rather than DSP (see loudness.test.ts).
  getChannelData(): Float32Array {
    return new Float32Array(0);
  }
}

/** One scheduled gain automation event, so tests can assert on fade shapes. */
export interface GainEvent {
  kind: 'set' | 'ramp' | 'cancel';
  value: number;
  time: number;
}

class StubNode {
  /** Automation recorded on this node, in call order. */
  events: GainEvent[] = [];
  gain = {
    value: 1,
    setValueAtTime: (value: number, time: number) => {
      this.events.push({ kind: 'set', value, time });
      this.gain.value = value;
    },
    linearRampToValueAtTime: (value: number, time: number) => {
      this.events.push({ kind: 'ramp', value, time });
    },
    cancelScheduledValues: (time: number) => {
      this.events.push({ kind: 'cancel', value: 0, time });
    },
  };
  fftSize = 256;
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  /** Arguments the source was started with: [when, offset, duration]. */
  startArgs: number[] | null = null;
  connect() {}
  disconnect() {}
  getFloatTimeDomainData() {}
  start(...args: number[]) {
    this.startArgs = args;
  }
  stop() {}
}

/**
 * Gain nodes created since the last reset, newest last — one per playback, so
 * `lastGainNode()` is the fade envelope of the most recently started cue.
 */
const gainNodes: StubNode[] = [];

export function resetGainNodes(): void {
  gainNodes.length = 0;
}

export function lastGainNode(): { events: GainEvent[] } | undefined {
  return gainNodes[gainNodes.length - 1];
}

export function allGainNodes(): { events: GainEvent[] }[] {
  return gainNodes;
}

/**
 * Install stub globals. Returns counters the test can assert on, plus a
 * teardown. Call before importing any module that touches the AudioContext.
 */
export function installAudioStubs(): StubCounters & { restore: () => void } {
  const counters: StubCounters = { decodes: 0, reads: 0 };
  const g = globalThis as Record<string, unknown>;
  const saved = { ...g };

  g.AudioContext = class {
    state = 'running';
    currentTime = 0;
    destination = new StubNode();
    async decodeAudioData() {
      counters.decodes++;
      return new StubAudioBuffer() as unknown as AudioBuffer;
    }
    resume() {
      return Promise.resolve();
    }
    createGain() {
      const node = new StubNode();
      gainNodes.push(node);
      return node;
    }
    createBufferSource() {
      return new StubNode();
    }
    createAnalyser() {
      return new StubNode();
    }
  };
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};
  g.window = globalThis;
  g.confirm = () => true;

  return {
    get decodes() {
      return counters.decodes;
    },
    get reads() {
      return counters.reads;
    },
    restore() {
      for (const key of ['AudioContext', 'requestAnimationFrame', 'cancelAnimationFrame', 'window', 'confirm']) {
        if (key in saved) g[key] = saved[key];
        else delete g[key];
      }
    },
  } as StubCounters & { restore: () => void };
}

export interface FakeFolderSpec {
  name?: string;
  /** Cue-file name -> file contents (JSON text). */
  cueFiles: Record<string, string>;
  /** Audio file names present in the folder. */
  audioFiles: string[];
  /** Video file names present in the folder. */
  videoFiles?: string[];
}

/** A directory handle backed by an in-memory listing. */
export function makeFakeDir(spec: FakeFolderSpec, counters?: { reads: number }) {
  const written: Record<string, string> = {};
  const videoFiles = spec.videoFiles ?? [];
  const dir: Record<string, unknown> = {
    name: spec.name ?? 'show-folder',
    isSameEntry: async (other: unknown) => other === dir,
    async getFileHandle(name: string, options?: { create?: boolean }) {
      const known =
        name in spec.cueFiles ||
        spec.audioFiles.includes(name) ||
        videoFiles.includes(name) ||
        name in written;
      if (!known && !options?.create) throw new Error(`no such file: ${name}`);
      return {
        // Stands in for a File. Video never reads the bytes on this side — the
        // screen page turns whatever comes back into an object URL — so the
        // name is enough for a test to tell one clip from another.
        getFile: async () => ({
          name,
          text: async () => written[name] ?? spec.cueFiles[name] ?? '',
          arrayBuffer: async () => {
            if (counters) counters.reads++;
            return new ArrayBuffer(16);
          },
        }),
        createWritable: async () => ({
          write: async (data: string) => {
            written[name] = data;
          },
          close: async () => {},
        }),
      };
    },
    async *values() {
      for (const n of [
        ...Object.keys(spec.cueFiles),
        ...Object.keys(written),
        ...spec.audioFiles,
        ...videoFiles,
      ]) {
        yield { kind: 'file', name: n };
      }
    },
    /** Test-only view of what save() wrote. */
    __written: written,
  };
  return dir;
}
