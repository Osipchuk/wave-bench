// Web Worker: runs the shallow-water solver off the main thread.
import { SimHost } from './sim-host.js';

const host = new SimHost();
let ready = true;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ack') { ready = true; return; }
  host.handle(m);
};

const channel = new MessageChannel();
channel.port1.onmessage = loop;

function loop() {
  const active = host.tick(28);
  if (ready && (host.dirty || active)) {
    const { msg, transfer } = host.snapshot();
    self.postMessage(msg, transfer);
    ready = false;
  }
  if (active) channel.port2.postMessage(0);
  else setTimeout(loop, 16);
}

self.postMessage({ type: 'hello' });
loop();
