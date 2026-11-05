// Small Commslayer client on native fetch. The token only goes into the Authorization header: it is never logged,
// and errors carry the HTTP status and the path with numbers replaced, never a response body.
const BASE = 'https://app.commslayer.com/api/integration/v1';

export class ApiError extends Error {
  constructor(status, method, path) {
    super(`HTTP ${status} ${method} ${path.replace(/\d+/g, 'N')}`);
    this.status = status;
  }
}
export class BudgetError extends Error {}

export function makeClient(token, { maxCalls = 60, gapMs = 1100 } = {}) {
  let last = 0, calls = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(method, path, { query, body, allow = [] } = {}) {
    if (calls >= maxCalls) throw new BudgetError('call budget reached');
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, last + gapMs - Date.now());
      if (wait) await sleep(wait);
      last = Date.now(); calls++;
      const url = new URL(BASE + path);
      for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(25000),
        });
      } catch { throw new ApiError(0, method, path); }
      if (res.status === 429 && attempt < 1) { await sleep(Math.min(Number(res.headers.get('retry-after') || 20), 40) * 1000); continue; }
      if (!res.ok && !allow.includes(res.status)) throw new ApiError(res.status, method, path);
      let json = null;
      if (res.ok) { try { json = await res.json(); } catch { throw new ApiError(res.status, method, path); } }
      return { status: res.status, body: json };
    }
  }

  const pages = async (path, query, maxPages = 3) => {          // cursor pagination: meta.next_cursor -> page[after]
    const out = []; let cursor;
    for (let i = 0; i < maxPages; i++) {
      const r = await call('GET', path, { query: { 'page[limit]': 100, ...query, ...(cursor ? { 'page[after]': cursor } : {}) } });
      if (!Array.isArray(r.body?.data)) throw new ApiError(502, 'GET', path);
      out.push(...r.body.data);
      cursor = r.body.meta?.next_cursor;
      if (!cursor) break;
    }
    return out;
  };

  return {
    account: async () => (await call('GET', '/account')).body?.data,
    openConversations: (inboxId) => pages('/conversations', { 'filter[status]': 'open', 'filter[inbox_id]': inboxId }),
    conversation: async (id) => { const r = await call('GET', `/conversations/${id}`, { allow: [404] }); return r.status === 404 ? null : r.body?.data; },
    messages: (id) => pages(`/conversations/${id}/messages`, {}, 3),
    draft: async (id) => { const r = await call('GET', `/conversations/${id}/draft`, { allow: [404] }); return r.status === 404 ? null : r.body?.data ?? null; },
    send: (id, content) => call('POST', `/conversations/${id}/messages`, { body: { message: { content, private: false } } }),
    patch: (id, conversation) => call('PATCH', `/conversations/${id}`, { body: { conversation } }),
    get calls() { return calls; },
  };
}
