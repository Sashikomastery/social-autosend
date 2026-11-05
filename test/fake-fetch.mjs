// Preloaded with `node --import`: replaces fetch with a fake Commslayer + Slack, and records the writes.
import fs from 'node:fs';
const T = Date.now();
const iso = (min) => new Date(T + min * 60_000).toISOString();
const SECRET_TEXT = 'SECRET-CUSTOMER-TEXT';
const msg = (id, type, min, content = SECRET_TEXT) => ({ id, message_type: type, private: false, content, sender_type: type === 'incoming' ? 'Contact' : 'User', created_at: iso(min) });
const convs = {
  101: { id: 101, inbox_id: 5002, assignee_id: null, status: 'open', labels: [], custom_attributes: { keep: 1 }, last_activity_at: iso(-30) },   // due, AI draft -> send
  102: { id: 102, inbox_id: 5002, assignee_id: null, status: 'open', labels: [], custom_attributes: {}, last_activity_at: iso(-30) },              // complaint -> hand over
  103: { id: 103, inbox_id: 5002, assignee_id: null, status: 'open', labels: [], custom_attributes: {}, last_activity_at: iso(-2) },               // too recent -> wait
  104: { id: 104, inbox_id: 5002, assignee_id: null, status: 'open', labels: [], custom_attributes: {}, last_activity_at: iso(-20) },              // human replied -> skip
};
const messages = {
  101: [msg(1, 'incoming', -30)], 102: [msg(2, 'incoming', -30, 'I want a REFUND')], 103: [msg(3, 'incoming', -2)],
  104: [msg(4, 'incoming', -20), msg(5, 'outgoing', -10)],
};
const drafts = { 101: { id: 9, content: 'DRAFT-TEXT-101', source: 'ai', created_at: iso(-18), updated_at: iso(-18) } };
const writes = [];
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), method = init.method || 'GET', p = u.pathname.replace('/api/integration/v1', '');
  if (u.hostname === 'slack.com') { writes.push(['SLACK']); return json({ ok: true }); }
  let m;
  if (p === '/account') return json({ data: { token: { expires_at: iso(60 * 24 * 90) } } });
  if (p === '/conversations') return json({ data: u.searchParams.get('filter[inbox_id]') === '5002' ? Object.values(convs) : [], meta: {} });
  if ((m = p.match(/^\/conversations\/(\d+)\/messages$/))) {
    if (method === 'POST') { writes.push(['SEND', Number(m[1]), JSON.parse(init.body).message.content]); return json({ data: {} }, 201); }
    return json({ data: messages[m[1]] || [], meta: {} });
  }
  if ((m = p.match(/^\/conversations\/(\d+)\/draft$/))) return drafts[m[1]] ? json({ data: drafts[m[1]] }) : json({ error: 'none' }, 404);
  if ((m = p.match(/^\/conversations\/(\d+)$/))) {
    if (method === 'PATCH') { const body = JSON.parse(init.body).conversation; if (body.assignee_id === 777) return json({}, 404); writes.push(['PATCH', Number(m[1]), body]); return json({ data: {} }); }
    return json({ data: convs[m[1]] });
  }
  return json({}, 500);
};
process.on('exit', () => fs.writeFileSync(process.env.WRITES_FILE, JSON.stringify(writes)));
