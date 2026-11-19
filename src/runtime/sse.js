/**
 * B：进程内事件总线 + SSE 客户端管理（M0-PLAN §3.3 / §3.8）。
 *
 * 设计：
 *  - `createEventBus()`：极简 pub/sub；service 写成功后 publish changed。
 *  - `createSseServer({bus})`：把总线事件转成 `text/event-stream`；
 *    连接即发 `hello`，业务事件发 `changed`，每 heartbeatMs 发 `heartbeat`；
 *    环形缓冲 ringSize 条，支持 `Last-Event-ID` 断线续传；超过缓冲则先发 `resync` 再 hello。
 *  - 所有定时器/订阅在 close() 清理；写失败只移除该连接，不影响业务。
 *
 * 不依赖任何第三方包，也不依赖 ctx（测试可直接造 fake req/res）。
 */

export function createEventBus() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          /* 单个订阅者异常不影响其它订阅者（观测失败不 rethrow） */
        }
      }
    },
    listenerCount() {
      return listeners.size;
    },
    clear() {
      listeners.clear();
    },
  };
}

function sseFrame(id, type, data) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  lines.push(`event: ${type}`);
  lines.push(`data: ${JSON.stringify(data ?? {})}`);
  return `${lines.join('\n')}\n\n`;
}

function writeChunk(res, text) {
  try {
    if (!res || typeof res.write !== 'function') return false;
    res.write(text);
    return true;
  } catch {
    return false;
  }
}

function endClient(client) {
  try {
    if (client.res && typeof client.res.end === 'function') client.res.end();
  } catch {
    /* ignore */
  }
}

function safeHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'X-LifeOS-Api': '0.1',
  };
}

/**
 * @param {object} options
 * @param {ReturnType<typeof createEventBus>} options.bus
 * @param {number} [options.heartbeatMs=15000]
 * @param {number} [options.ringSize=50]
 * @param {(ms:number, fn:Function)=>any} [options.setIntervalImpl] 测试注入
 * @param {()=>void} [options.clearIntervalImpl]
 * @param {()=>number} [options.now]
 */
export function createSseServer(options = {}) {
  const bus = options.bus;
  if (!bus || typeof bus.subscribe !== 'function') throw new TypeError('createSseServer requires a bus');
  const heartbeatMs = Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0 ? options.heartbeatMs : 15000;
  const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0 ? options.ringSize : 50;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setIntervalImpl = options.setIntervalImpl || ((ms, fn) => setInterval(fn, ms));
  const clearIntervalImpl = options.clearIntervalImpl || ((handle) => clearInterval(handle));

  const clients = new Set();
  const ring = [];
  let seq = 0;
  let heartbeat = null;
  let closed = false;
  const unsubscribeBus =
    typeof bus.subscribe === 'function'
      ? bus.subscribe((event) => {
          try {
            publish(event);
          } catch {
            /* 广播失败不影响总线其它订阅者 */
          }
        })
      : null;

  function pushRing(entry) {
    ring.push(entry);
    while (ring.length > ringSize) ring.shift();
    return entry;
  }

  function publish(event) {
    if (closed) return null;
    const entry = pushRing({
      id: String(++seq),
      type: event && typeof event.type === 'string' ? event.type : 'changed',
      data: event && event.data !== undefined ? event.data : {},
      at: now(),
    });
    const frame = sseFrame(entry.id, entry.type, entry.data);
    for (const client of [...clients]) {
      if (!writeChunk(client.res, frame)) removeClient(client);
    }
    return entry;
  }

  function removeClient(client) {
    if (!client || !clients.has(client)) return;
    clients.delete(client);
    endClient(client);
  }

  function replayAfter(lastId, client) {
    if (lastId === null || lastId === undefined || lastId === '') return true;
    const last = Number(lastId);
    if (!Number.isFinite(last) || ring.length === 0) return false;
    const oldest = Number(ring[0].id);
    if (last < oldest - 1) return false; // 缓冲已滚出：要求客户端全量重拉
    for (const entry of ring) {
      if (Number(entry.id) > last) {
        if (!writeChunk(client.res, sseFrame(entry.id, entry.type, entry.data))) return false;
      }
    }
    return true;
  }

  /**
   * 接管一个已鉴权的 GET /events 请求。
   * @returns {{handled:true, client:object}}
   */
  function handle(req, res) {
    if (closed) {
      if (res && typeof res.writeHead === 'function') {
        try {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: { code: 'store_unavailable', message: 'SSE 已关闭' } }));
        } catch {
          /* ignore */
        }
      }
      return { handled: true, client: null };
    }
    if (res && typeof res.writeHead === 'function') {
      try {
        res.writeHead(200, safeHeaders());
      } catch {
        /* ignore：测试 fake res 可不实现 */
      }
    }
    if (typeof res.setHeader === 'function') {
      const headers = safeHeaders();
      for (const [key, value] of Object.entries(headers)) {
        try {
          res.setHeader(key, value);
        } catch {
          /* ignore */
        }
      }
    }
    writeChunk(res, `retry: 3000\n\n`);

    const client = { res, id: null, connectedAt: now() };
    clients.add(client);

    const lastEventId =
      (req && req.headers && (req.headers['last-event-id'] || req.headers['Last-Event-ID'])) || null;
    const resumed = replayAfter(lastEventId, client);
    if (!resumed) {
      writeChunk(res, sseFrame(null, 'resync', { reason: 'buffer_exhausted', at: now() }));
    }
    writeChunk(
      res,
      sseFrame(null, 'hello', {
        apiVersion: '0.1',
        heartbeatMs,
        resumed: Boolean(lastEventId) && resumed,
        at: now(),
      }),
    );

    const cleanup = () => {
      if (client.cleaned) return;
      client.cleaned = true;
      clients.delete(client);
    };
    client.cleanup = cleanup;
    try {
      if (req && typeof req.on === 'function') req.on('close', cleanup);
      if (req && typeof req.on === 'function') req.on('error', cleanup);
      if (res && typeof res.on === 'function') res.on('close', cleanup);
      if (res && typeof res.on === 'function') res.on('error', cleanup);
    } catch {
      /* ignore */
    }
    return { handled: true, client };
  }

  if (!heartbeat) {
    heartbeat = setIntervalImpl(heartbeatMs, () => {
      const frame = sseFrame(null, 'heartbeat', { at: now() });
      for (const client of [...clients]) {
        if (!writeChunk(client.res, frame)) removeClient(client);
      }
    });
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      if (typeof unsubscribeBus === 'function') unsubscribeBus();
    } catch {
      /* ignore */
    }
    if (heartbeat) {
      try {
        clearIntervalImpl(heartbeat);
      } catch {
        /* ignore */
      }
      heartbeat = null;
    }
    for (const client of [...clients]) removeClient(client);
    clients.clear();
  }

  return {
    handle,
    publish,
    close,
    clientCount: () => clients.size,
    getSeq: () => seq,
    ringSize: () => ring.length,
    isClosed: () => closed,
  };
}

/* ───────────── M2.5：笔记外部改动事件（notes/changed）───────────── */

import { NOTES_CHANGED_EVENT, NOTE_CHANGE_KINDS } from '../client-shared/contract.js';

export { NOTES_CHANGED_EVENT, NOTE_CHANGE_KINDS };

/**
 * 发布笔记文件变更事件（交给 createSseServer 广播为 `event: notes/changed`）。
 * 与既有 `changed` 广播完全兼容：同一 bus、同一连接、同一环形缓冲。
 * @param {object} bus createEventBus()
 * @param {{path:string, kind:'add'|'change'|'unlink', at?:string}} change
 * @returns {{path:string,kind:string,at:string}|null}
 */
export function publishNoteChange(bus, change) {
  if (!bus || typeof bus.publish !== 'function') return null;
  const pathValue = typeof change?.path === 'string' ? change.path : '';
  const kind = NOTE_CHANGE_KINDS.includes(change?.kind) ? change.kind : 'change';
  if (!pathValue) return null;
  const payload = {
    path: pathValue,
    kind,
    at: typeof change?.at === 'string' ? change.at : new Date().toISOString(),
  };
  bus.publish({ type: NOTES_CHANGED_EVENT, data: payload });
  return payload;
}
