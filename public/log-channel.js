// Short HTTP polls preserve live logs on proxies that do not support SSE.
(() => {
  const settings = fetch('/api/auth/public-settings', { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => response.json()).catch(() => ({ logTransport: 'sse' }));
  function connect(url) {
    const listeners = new Map();
    const abort = new AbortController();
    let closed = false, timer, source, cursor = 0;
    const channel = {
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      close() {
        closed = true;
        clearTimeout(timer);
        abort.abort();
        source?.close();
      }
    };
    const emit = (type, data) => {
      if (!closed) for (const callback of listeners.get(type) || []) callback({ data: JSON.stringify(data) });
    };
    async function poll() {
      if (closed) return;
      let delay = 1500;
      try {
        const response = await fetch(`${url}?transport=poll&after=${cursor}`, {
          cache: 'no-store', credentials: 'same-origin', signal: abort.signal
        });
        if (response.status === 401) { channel.close(); window.location.replace('/login'); return; }
        if (!response.ok) throw new Error(`Log polling returned HTTP ${response.status}`);
        const data = await response.json();
        for (const log of data.logs || []) emit('log', log);
        cursor = data.cursor || cursor;
        emit('status', { status: data.status, progress: data.progress });
        if (['completed', 'failed', 'cancelled'].includes(data.status) && !data.hasMore) {
          emit('done', { status: data.status, error: data.error });
          channel.close();
          return;
        }
        if (data.hasMore) delay = 25;
      } catch (error) {
        if (closed) return;
        emit('error', { message: error.message });
        delay = 3000;
      }
      if (!closed) timer = setTimeout(poll, delay);
    }
    settings.then((config) => {
      if (closed) return;
      if (config.logTransport === 'poll') return poll();
      source = new EventSource(url);
      for (const type of ['log', 'status', 'done', 'error']) {
        source.addEventListener(type, (event) => {
          if (!closed) for (const callback of listeners.get(type) || []) callback(event);
        });
      }
    });
    return channel;
  }
  window.FreeAuditLogs = { connect };
})();
