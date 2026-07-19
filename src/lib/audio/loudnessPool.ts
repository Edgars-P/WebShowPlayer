// A small worker pool that measures loudness-normalization gain off the main
// thread. Falls back to synchronous main-thread measurement if Workers aren't
// available (or fail to construct).

import { measureNormalizeGain, type LoudnessRequest, type LoudnessResponse } from './loudness';

/**
 * Cap on concurrent measurements. Each in-flight job holds a full Float32 copy
 * of one track's samples (~20 MB per stereo minute, so a 5-minute track is
 * ~100 MB), which makes this a memory ceiling as much as a CPU one — leaving a
 * core for the UI and the browser's own decode threads is the point, not
 * saturating every core.
 */
const MAX_WORKERS = 3;

interface Job {
  req: LoudnessRequest;
  transfer: Transferable[];
  resolve: (gain: number) => void;
}

class LoudnessPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private pending = new Map<number, (gain: number) => void>();
  private nextId = 1;
  private unavailable = false;

  private size(): number {
    const cores = navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
  }

  private spawn(): Worker | null {
    try {
      const worker = new Worker(new URL('./loudness.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent<LoudnessResponse>) => {
        const resolve = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        resolve?.(e.data.gain);
        this.release(worker);
      };
      worker.onerror = () => {
        // A broken worker shouldn't wedge the queue; drop it and let the pool
        // spawn a fresh one (or fall back) for the next job.
        this.workers = this.workers.filter((w) => w !== worker);
        this.idle = this.idle.filter((w) => w !== worker);
      };
      this.workers.push(worker);
      return worker;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) {
      this.dispatch(worker, next);
    } else {
      this.idle.push(worker);
    }
  }

  private dispatch(worker: Worker, job: Job): void {
    this.pending.set(job.req.id, job.resolve);
    worker.postMessage(job.req, job.transfer);
  }

  /**
   * Measure a decoded buffer's normalization gain. The buffer's channel data is
   * copied (its own views belong to the AudioBuffer and can't be transferred
   * without detaching them) and the copies are transferred to the worker.
   */
  measure(buffer: AudioBuffer): Promise<number> {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(new Float32Array(buffer.getChannelData(c)));
    }
    const sampleRate = buffer.sampleRate;

    if (this.unavailable || typeof Worker === 'undefined') {
      return Promise.resolve(measureNormalizeGain(channels, sampleRate));
    }

    return new Promise<number>((resolve) => {
      const req: LoudnessRequest = { id: this.nextId++, channels, sampleRate };
      const transfer = channels.map((c) => c.buffer);
      const job: Job = { req, transfer, resolve };

      const worker = this.idle.pop() ?? (this.workers.length < this.size() ? this.spawn() : null);
      if (worker) {
        this.dispatch(worker, job);
      } else if (this.unavailable) {
        resolve(measureNormalizeGain(channels, sampleRate));
      } else {
        this.queue.push(job);
      }
    });
  }
}

export const loudnessPool = new LoudnessPool();
