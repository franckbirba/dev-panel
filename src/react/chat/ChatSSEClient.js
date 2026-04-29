// SSE client for the widget chat stream. Wraps EventSource with exponential
// reconnect (1s → 30s) and a pluggable transport so tests can inject a fake.
//
// Status callbacks: 'connecting' | 'open' | 'reconnecting' | 'closed'.
// Messages are forwarded after JSON.parse; non-JSON keepalive frames are
// silently ignored.

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export class ChatSSEClient {
  constructor({ url, EventSource: ES, onMessage, onStatus } = {}) {
    this.url = url;
    this.ES = ES ?? (typeof window !== 'undefined' ? window.EventSource : null);
    this.onMessage = onMessage ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.es = null;
    this.timer = null;
    this.attempt = 0;
    this.disposed = false;
  }

  connect() {
    if (this.disposed) return;
    if (!this.ES) return;
    this.onStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    const es = new this.ES(this.url);
    this.es = es;
    es.onopen = () => {
      this.attempt = 0;
      this.onStatus('open');
    };
    es.onmessage = (e) => {
      let parsed;
      try { parsed = JSON.parse(e.data); }
      catch { return; }
      this.onMessage(parsed);
    };
    es.onerror = () => {
      this.onStatus('reconnecting');
      try { es.close(); } catch { /* ignore */ }
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this.disposed || this.timer) return;
    const delay = Math.min(MIN_DELAY_MS * (2 ** this.attempt), MAX_DELAY_MS);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  disconnect() {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.es) {
      try { this.es.close(); } catch { /* ignore */ }
      this.es = null;
    }
    this.onStatus('closed');
  }
}
