/** B 测试辅助：直调 HTTP handler 的 fake req/res（不起真实 HTTP）。 */

export const HOST = '127.0.0.1:52508';

export function makeReq({ method = 'GET', url = '/api/lifeos/health', headers = {}, body } = {}) {
  const listeners = new Map();
  return {
    method,
    url,
    headers: { host: HOST, ...headers },
    body: body === undefined ? '' : body,
    on(event, fn) {
      listeners.set(event, fn);
    },
  };
}

export function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 0,
    headers,
    on() {},
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
    },
    writeHead(code, extra) {
      this.statusCode = code;
      if (extra) for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      this.ended = true;
    },
    text() {
      return chunks.join('');
    },
    json() {
      return JSON.parse(this.text());
    },
  };
}

/** 调用 handler，返回 {status, json, headers, res} */
export async function call(routes, opts) {
  const req = makeReq(opts);
  const res = makeRes();
  await routes.handle(req, res);
  return { status: res.statusCode, json: () => res.json(), headers: res.headers, res };
}

/** 便捷：带 If-Match 的写请求 */
export function callWrite(routes, { method, url, body, rev, headers = {} }) {
  const finalHeaders = { ...headers };
  if (rev !== undefined && rev !== null) finalHeaders['if-match'] = String(rev);
  return call(routes, {
    method,
    url,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
