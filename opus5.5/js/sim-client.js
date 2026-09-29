// Main-thread facade over the simulation: prefers a Web Worker, falls back to local stepping.
import { SimHost } from './sim-host.js';

export class SimClient {
  constructor() {
    this.latest = null;
    this.mode = 'starting';
    this.queue = [];
    try {
      this.worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'hello') {
          this.mode = 'worker';
          for (const q of this.queue) this.worker.postMessage(q);
          this.queue.length = 0;
          return;
        }
        this.latest = m;
      };
      this.worker.onerror = () => this._fallback();
      setTimeout(() => { if (this.mode === 'starting') this._fallback(); }, 4000);
    } catch (err) {
      this._fallback();
    }
  }

  _fallback() {
    if (this.mode === 'local') return;
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } this.worker = null; }
    this.mode = 'local';
    this.host = new SimHost();
    for (const q of this.queue) this.host.handle(q);
    this.queue.length = 0;
    console.warn('[sim] Web Worker unavailable — running the solver on the main thread.');
  }

  send(msg) {
    if (this.mode === 'worker') this.worker.postMessage(msg);
    else if (this.mode === 'local') this.host.handle(msg);
    else this.queue.push(msg);
  }

  // Returns the newest snapshot (or null if nothing new).
  pull() {
    if (this.mode === 'worker') {
      const s = this.latest;
      if (s) { this.latest = null; this.worker.postMessage({ type: 'ack' }); }
      return s;
    }
    if (this.mode === 'local') {
      const active = this.host.tick(10);
      if (active || this.host.dirty) return this.host.snapshot().msg;
    }
    return null;
  }
}
