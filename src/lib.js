// Pure decision logic (no network, no logging), so it can be tested with plain objects.
import crypto from 'node:crypto';

export const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const parseList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
export const parseIds = (s) => parseList(s).map(Number).filter(Number.isInteger);
export function parseKinds(s) {                           // "5001:messenger,5002:comment" -> Map(5001 -> 'messenger')
  const m = new Map();
  for (const p of parseList(s)) { const [id, k] = p.split(':'); if (Number(id) && k) m.set(Number(id), k.trim().toLowerCase()); }
  return m;
}
export function complaintRegex(words) {                   // whole word / whole phrase, case-insensitive, unicode-aware
  const parts = words.map((w) => w.trim()).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  if (!parts.length) return /(?!)/u;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}
export function romeParts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

const t = (m) => Date.parse(m.created_at);
const byTime = (a, b) => t(a) - t(b) || a.id - b.id;

// First pass. Returns { action: skip | wait | complete | handoff | check-draft | new-cycle, reason, lastIn, ... }.
//   new-cycle: the customer wrote again after our auto-reply; the caller re-rolls the delay and calls evaluate again.
//   st = state entry for this conversation (or undefined), delayMin = its random delay (10-27 min), saved once per conversation.
export function evaluate({ conv, msgs, st, now, delayMin, cfg }) {
  const real = msgs.filter((m) => !m.private && (m.message_type === 'incoming' || m.message_type === 'outgoing')).sort(byTime);
  const incoming = real.filter((m) => m.message_type === 'incoming');
  const lastIn = incoming.at(-1);
  if (!lastIn) return { action: 'skip', reason: 'no-customer-message', terminal: true };
  const inAt = t(lastIn), same = !!st && st.msgId === lastIn.id;

  let newCycle = false;
  if (st && !same) {                                      // the customer wrote again after we already dealt with the conversation
    if (st.outcome === 'handed') return { action: 'skip', reason: 'handed-earlier', terminal: false, lastIn };
    newCycle = st.outcome === 'sent';                     // after our auto-reply: a new normal cycle, like a first message
  }
  if (same && st.done) return { action: 'skip', reason: 'done', terminal: true, lastIn };

  const after = real.slice(real.lastIndexOf(lastIn) + 1).filter((m) => m.message_type === 'outgoing');
  if (after.length) {                                     // someone already answered this customer message
    if (same && st.sentHash && after.some((m) => sha(m.content || '') === st.sentHash)) return { action: 'complete', reason: 'send-confirmed', lastIn };
    return { action: 'skip', reason: 'human-replied', terminal: true, lastIn, senders: after.map((m) => m.sender_type || '?') };
  }
  if (now - inAt > cfg.maxAgeMs) return { action: 'skip', reason: 'too-old', terminal: true, lastIn };
  if (newCycle) {
    if ((st.autoReplies ?? 1) >= (cfg.maxAutoReplies ?? 5)) return { action: 'handoff', reason: 'auto-reply-limit', lastIn };   // state from before the counter: a sent conversation had at least 1
    return { action: 'new-cycle', lastIn };
  }
  const dueAt = inAt + delayMin * 60_000;
  if (!cfg.ignoreDelay && now < dueAt) return { action: 'wait', dueAt, lastIn };

  if ((conv.labels || []).some((l) => /^ai-handover/i.test(l))) return { action: 'handoff', reason: 'ai-handover', lastIn };
  if (incoming.some((m) => cfg.complaintRe.test(m.content || ''))) return { action: 'handoff', reason: 'complaint-word', lastIn };
  const lastOut = real.map((m) => m.message_type).lastIndexOf('outgoing');
  if (real.slice(lastOut + 1).filter((m) => m.message_type === 'incoming').length >= 3) return { action: 'handoff', reason: 'three-in-a-row', lastIn };
  return { action: 'check-draft', lastIn };
}

// Second pass, once the draft has been read (draft = null when the conversation has none).
export function judgeDraft(draft, lastIn) {
  if (!draft || !String(draft.content || '').trim()) return { action: 'handoff', reason: 'no-draft', lastIn };
  if (draft.source !== 'ai') return { action: 'skip', reason: 'human-draft', terminal: true, lastIn };
  const at = Date.parse(draft.updated_at || draft.created_at || '');
  if (!Number.isFinite(at) || at < Date.parse(lastIn.created_at)) return { action: 'handoff', reason: 'draft-older-than-message', lastIn };
  return { action: 'send', text: draft.content, lastIn };
}
