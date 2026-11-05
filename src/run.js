// social-autosend: sends the AI draft of Facebook comments / Messenger DMs 10-15 minutes after the customer wrote, then resolves.
// Logs contain conversation ids and short codes only. Never message texts, names or tokens.
import { makeClient, ApiError, BudgetError } from './commslayer.js';
import { sendSlack } from './slack.js';
import { loadState, saveState } from './state.js';
import { evaluate, judgeDraft, parseIds, parseKinds, parseList, complaintRegex, romeParts, sha } from './lib.js';

const env = process.env;
const MANUAL = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
const REAL = env.SEND_ENABLED === 'true' && env.DRY_RUN !== 'true';
const DRY = !REAL;
if (!MANUAL && DRY) { console.log('disabled: SEND_ENABLED is not "true", nothing to do'); process.exit(0); }
if (MANUAL && env.DRY_RUN === 'false' && env.SEND_ENABLED !== 'true') console.log('SEND_ENABLED is not "true": running as a dry run');

const missing = ['COMMSLAYER_TOKEN_SOCIAL', 'INBOX_IDS', 'AGENT_CHAIN'].filter((k) => !env[k]);
if (missing.length) { console.error(`missing settings: ${missing.join(', ')}`); process.exit(1); }

const INBOXES = parseIds(env.INBOX_IDS), KINDS = parseKinds(env.INBOX_KINDS), CHAIN = parseIds(env.AGENT_CHAIN);
const cfg = {
  complaintRe: complaintRegex(parseList(env.COMPLAINT_WORDS)),
  maxAgeMs: Number((MANUAL && DRY && env.MAX_AGE_HOURS_DRY) || env.MAX_AGE_HOURS || 24) * 3600_000,   // the dry-run override never applies to real sending         // older customer messages are left to the humans
  ignoreDelay: MANUAL && DRY && env.IGNORE_DELAY === 'true',
};
const now = Date.now();
const state = loadState();
const cl = makeClient(env.COMMSLAYER_TOKEN_SOCIAL, { maxCalls: Number(env.MAX_CALLS || 60) });
const slack = (text) => sendSlack(env.SLACK_BOT_TOKEN, env.SLACK_USER_ID, text);
const save = () => { if (REAL) saveState(state, Date.now()); };
const kindOf = (inbox) => KINDS.get(inbox) || 'unknown';
const log = (id, msg) => console.log(`conversation ${id}: ${msg}`);

const tally = {};                                                // decision -> [ids], for the dry-run summary
const note = (key, id) => (tally[key] ||= []).push(id);
const senderTypes = new Set();

async function alert(key, text) {                                // immediate DM, at most once per 3 hours per key
  console.log(`alert: ${key}`);
  if (DRY && !MANUAL) return;
  if (state.alerted[key] && now - state.alerted[key] < 3 * 3600_000) return;
  state.alerted[key] = now;
  if (REAL) await slack(`social-autosend: ${text}`);
}
const event = (e) => { if (REAL) state.events.push({ t: Date.now(), ...e }); };
const fail = async (id, inbox, err) => {                          // one unexpected response: log code only, record, alert
  const code = err instanceof ApiError ? `HTTP ${err.status}` : 'error';
  log(id, `failed (${code})`);
  event({ id, kind: 'error', channel: kindOf(inbox), reason: code });
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) await alert('token-rejected', `Commslayer rejected the token (${err.status}). Nothing is being sent.`);
  else await alert(`error:${code}`, `API error ${code} on conversation ${id}.`);
};

// Assign by the fallback chain, starting at `from`. An agent that does not exist or is deactivated answers 400/404/422.
async function assign(conv, from = 0) {
  const unavailable = [];
  for (let i = from; i < CHAIN.length; i++) {
    try { await cl.patch(conv.id, { assignee_id: CHAIN[i] }); return { idx: i, unavailable }; }
    catch (e) { if (e instanceof ApiError && [400, 404, 422].includes(e.status)) { unavailable.push(i + 1); continue; } throw e; }
  }
  return { idx: null, unavailable };
}
async function markNeedsHuman(conv) {
  try { await cl.patch(conv.id, { custom_attributes: { ...(conv.custom_attributes || {}), needs_human: true } }); return 'ok'; }
  catch (e) { return e instanceof ApiError ? `failed ${e.status}` : 'failed'; }
}

async function handoff(conv, st, ev) {
  note(`handoff:${ev.reason}`, conv.id);
  if (DRY) { log(conv.id, `would hand to a human (${ev.reason})`); return; }
  st.msgId = ev.lastIn.id;
  if (conv.assignee_id) { st.assignedIdx = -1; log(conv.id, `kept with its assignee (${ev.reason})`); }
  else {
    const r = await assign(conv, 0);
    st.assignedIdx = r.idx; st.assignedAt = Date.now();
    if (r.idx === null) { await alert(`chain-empty:${conv.id}`, `No agent in the chain is available. Conversation ${conv.id} was not assigned and nothing was sent.`); log(conv.id, 'no agent available'); }
    else {
      log(conv.id, `assigned to chain position ${r.idx + 1} (${ev.reason})`);
      if (r.unavailable.length) { event({ id: conv.id, kind: 'fallback' }); await alert(`fallback:${conv.id}`, `Fallback used: chain position(s) ${r.unavailable.join(', ')} unavailable, conversation ${conv.id} went to position ${r.idx + 1}.`); }
    }
  }
  const a = await markNeedsHuman(conv);
  st.outcome = 'handed'; st.done = true; st.reason = ev.reason; st.touched = Date.now();
  event({ id: conv.id, kind: ev.event === 'replied_again' ? 'replied_again' : 'handed', channel: kindOf(conv.inbox_id), reason: ev.reason });
  if (ev.event === 'replied_again') log(conv.id, 'customer replied again after the auto-reply');
  log(conv.id, `needs_human attribute: ${a}`);
}

async function finish(conv, st) {                                 // after a confirmed send: resolve, mark with auto_sent
  try { await cl.patch(conv.id, { status: 'resolved' }); log(conv.id, 'resolved'); }
  catch (e) { await fail(conv.id, conv.inbox_id, e); }
  try { await cl.patch(conv.id, { custom_attributes: { ...(conv.custom_attributes || {}), auto_sent: true } }); log(conv.id, 'auto_sent attribute: ok'); }
  catch (e) { log(conv.id, `auto_sent attribute: failed ${e instanceof ApiError ? e.status : ''}`.trim()); }
}

async function send(conv, st, ev) {
  note('send', conv.id);
  if (DRY) { log(conv.id, `would send the draft (${kindOf(conv.inbox_id)}, delay ${st.delayMin.toFixed(1)} min)`); return; }
  if ((st.attempts || 0) >= 3) { await handoff(conv, st, { reason: 'send-failed', lastIn: ev.lastIn }); await alert(`send-failed:${conv.id}`, `Sending failed 3 times on conversation ${conv.id}. It was handed to a human.`); return; }
  st.attempts = (st.attempts || 0) + 1; st.msgId = ev.lastIn.id; st.sentHash = sha(ev.text); st.touched = Date.now();
  save();                                                          // written BEFORE sending: if the run dies, the next run can tell whether it went out
  try { await cl.send(conv.id, ev.text); }                         // the draft exactly as it is
  catch (e) { await fail(conv.id, conv.inbox_id, e); if (st.attempts >= 3) await alert(`send-failed:${conv.id}`, `Sending failed 3 times on conversation ${conv.id}.`); return; }
  st.outcome = 'sent'; st.done = true; st.sentAt = Date.now();
  event({ id: conv.id, kind: 'sent', channel: kindOf(conv.inbox_id), delayMin: (Date.now() - Date.parse(ev.lastIn.created_at)) / 60000 });
  log(conv.id, 'sent');
  await finish(conv, st);
}

async function processConversation(conv) {
  let st = state.convs[conv.id];
  if (st?.outcome === 'handed') return;                            // handed to a human: not touched again (the 24 h check below handles escalation)
  if (st && st.seenActivity === conv.last_activity_at && (st.done || (st.waitUntil && Date.now() < st.waitUntil && !cfg.ignoreDelay))) return;   // nothing new: no API call
  const msgs = await cl.messages(conv.id);
  for (const m of msgs) if (m.sender_type) senderTypes.add(`${m.message_type}:${m.sender_type}`);
  if (!st) st = state.convs[conv.id] = { delayMin: 10 + Math.random() * 5 };     // random delay picked once per conversation
  st.touched = Date.now();
  const ev = evaluate({ conv, msgs, st, now: Date.now(), delayMin: st.delayMin, cfg });
  st.seenActivity = conv.last_activity_at;
  if (ev.lastIn && st.msgId !== ev.lastIn.id) { st.done = false; st.attempts = 0; st.sentHash = undefined; st.waitUntil = undefined; }   // a new customer message starts a new cycle
  switch (ev.action) {
    case 'wait': st.waitUntil = ev.dueAt; note('wait', conv.id); log(conv.id, `waiting until the delay is over (${st.delayMin.toFixed(1)} min)`); return;
    case 'skip':
      note(`skip:${ev.reason}`, conv.id); log(conv.id, `skipped (${ev.reason.replace('human-replied', 'human replied')})${ev.senders ? ` senders ${[...new Set(ev.senders)].join('/')}` : ''}`);
      if (ev.terminal && REAL) { st.msgId = ev.lastIn?.id ?? st.msgId; st.done = true; st.outcome = st.outcome || 'skipped'; }
      return;
    case 'complete': note('complete', conv.id); if (REAL) { st.outcome = 'sent'; st.done = true; log(conv.id, 'earlier send confirmed'); await finish(conv, st); } return;
    case 'handoff': return handoff(conv, st, ev);
    case 'check-draft': {
      const j = judgeDraft(await cl.draft(conv.id), ev.lastIn);
      if (j.action === 'send') return send(conv, st, j);
      if (j.action === 'handoff') return handoff(conv, st, j);
      note(`skip:${j.reason}`, conv.id); log(conv.id, `skipped (${j.reason})`);
      if (REAL) { st.msgId = j.lastIn.id; st.done = true; st.outcome = 'skipped'; }
    }
  }
}

// A handed conversation that nobody answered for 24 h moves to the next agent in the chain.
async function escalate() {
  for (const [id, st] of Object.entries(state.convs)) {
    if (st.outcome !== 'handed' || !(st.assignedIdx >= 0) || st.escalationDone) continue;
    if (Date.now() - st.assignedAt < 24 * 3600_000 || (st.nextCheck || 0) > Date.now()) continue;
    st.nextCheck = Date.now() + 3600_000;
    const conv = await cl.conversation(id);
    if (!conv || conv.status !== 'open' || conv.assignee_id !== CHAIN[st.assignedIdx]) { st.escalationDone = true; continue; }
    const msgs = (await cl.messages(id)).filter((m) => !m.private && ['incoming', 'outgoing'].includes(m.message_type)).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const lastIn = msgs.map((m) => m.message_type).lastIndexOf('incoming');
    if (msgs.slice(lastIn + 1).some((m) => m.message_type === 'outgoing')) { st.escalationDone = true; continue; }
    if (st.assignedIdx + 1 >= CHAIN.length) { st.escalationDone = true; await alert(`chain-exhausted:${id}`, `Conversation ${id} is still unanswered after 24 h and the chain has no further agent.`); continue; }
    const r = await assign(conv, st.assignedIdx + 1);
    if (r.idx === null) { st.escalationDone = true; await alert(`chain-empty:${id}`, `Conversation ${id} unanswered after 24 h and no further agent is available.`); continue; }
    st.assignedIdx = r.idx; st.assignedAt = Date.now(); event({ id: Number(id), kind: 'fallback' });
    log(id, `unanswered 24 h: moved to chain position ${r.idx + 1}`);
    await alert(`escalate:${id}:${r.idx}`, `Conversation ${id} was unanswered for 24 h: moved to chain position ${r.idx + 1}.`);
  }
}

async function dailyReport() {
  const p = romeParts(Date.now());
  if (state.reportedDate === p.ymd || p.hour < 8 || (p.hour === 8 && p.minute < 30)) return;
  state.reportedDate = p.ymd;
  const y = romeParts(Date.now() - 86400_000).ymd, ev = state.events.filter((e) => romeParts(e.t).ymd === y);
  if (!ev.length) return;                                          // nothing happened: no message
  const sent = ev.filter((e) => e.kind === 'sent'), n = (k, c) => sent.filter((e) => e.channel === c).length;
  const avg = sent.length ? (sent.reduce((a, e) => a + (e.delayMin || 0), 0) / sent.length).toFixed(1) : '-';
  await slack(`social-autosend ${y}: auto-sent ${sent.length} (comments ${n('', 'comment')}, Messenger ${n('', 'messenger')}); handed to humans ${ev.filter((e) => e.kind === 'handed').length}; customers who replied again ${ev.filter((e) => e.kind === 'replied_again').length}; average delay ${avg} min; errors ${ev.filter((e) => e.kind === 'error').length}.`);
}

async function probe(id) {                                         // manual only: does Commslayer accept the custom_attributes keys?
  const conv = await cl.conversation(id);
  if (!conv) { console.log('probe: conversation not found'); return; }
  const before = Object.keys(conv.custom_attributes || {});
  await cl.patch(id, { custom_attributes: { ...(conv.custom_attributes || {}), auto_sent: true, needs_human: true } });
  const after = (await cl.conversation(id))?.custom_attributes || {};
  console.log(`probe on conversation ${id}: attribute keys before [${before.join(', ')}], after [${Object.keys(after).join(', ')}]; auto_sent kept: ${after.auto_sent === true}; needs_human kept: ${after.needs_human === true}`);
}

(async () => {
  console.log(`mode: ${REAL ? 'REAL' : 'DRY RUN'}${cfg.ignoreDelay ? ' (delay ignored)' : ''}; inboxes ${INBOXES.length}; chain length ${CHAIN.length}`);
  try {
    let acct;
    try { acct = await cl.account(); }
    catch (e) { await fail(0, 0, e); process.exitCode = 1; return; }
    const exp = acct?.token?.expires_at;
    if (exp) {
      const days = (Date.parse(exp) - Date.now()) / 86400_000;
      console.log(`token expires in ${Math.floor(days)} days`);
      if (days <= 31 && state.expiryReminded !== exp) { state.expiryReminded = exp; if (REAL || MANUAL) await slack(`social-autosend: the Commslayer token expires in ${Math.floor(days)} days (${exp.slice(0, 10)}). Create a new one and update the secret.`); }
    }
    if (MANUAL && env.PROBE_CONVERSATION_ID) { await probe(Number(env.PROBE_CONVERSATION_ID)); return; }

    for (const inbox of INBOXES) {
      let list;
      try { list = await cl.openConversations(inbox); } catch (e) { if (e instanceof BudgetError) throw e; await fail(0, inbox, e); continue; }
      console.log(`inbox ${inbox} (${kindOf(inbox)}): ${list.length} open conversations`);
      for (const conv of list) {
        try { await processConversation(conv); }
        catch (e) { if (e instanceof BudgetError) throw e; await fail(conv.id, inbox, e); }
        save();
      }
    }
    if (REAL) await escalate();
    if (REAL) await dailyReport();
  } catch (e) {
    if (e instanceof BudgetError) console.log('call budget reached: the rest continues in the next run');
    else { console.log(`stopped: ${e instanceof ApiError ? `HTTP ${e.status}` : 'unexpected error'}`); process.exitCode = 1; }
  } finally {
    save();
    console.log(`api calls this run: ${cl.calls}`);
    if (senderTypes.size) console.log(`sender types seen: ${[...senderTypes].sort().join(', ')}`);
    if (DRY) {
      const lines = Object.entries(tally).map(([k, v]) => `${k}: ${v.length}${v.length ? ` [${v.slice(0, 15).join(', ')}${v.length > 15 ? ', …' : ''}]` : ''}`);
      console.log(`dry-run summary (ids only):\n${lines.join('\n') || 'nothing to do'}`);
      if (MANUAL) await slack(`social-autosend dry run, what it would do (ids only):\n${lines.join('\n') || 'nothing to do'}`);
    }
  }
})();
