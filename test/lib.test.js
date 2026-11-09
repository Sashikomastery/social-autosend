import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, judgeDraft, complaintRegex, parseKinds, sha, romeParts } from '../src/lib.js';

const WORDS = 'refund,sue,cancel my order,rip off,truffa,fuck'.split(',');
const PURCHASE = 'wholesale,where can i buy'.split(',');                       // fake words for the tests only
const cfg = { complaintRe: complaintRegex(WORDS), purchaseRe: complaintRegex(PURCHASE), noReplyMax: 60, maxAgeMs: 24 * 3600_000, ignoreDelay: false, maxAutoReplies: 15 };
const T0 = Date.parse('2026-11-05T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const inc = (id, min, content = 'hello') => ({ id, message_type: 'incoming', private: false, content, created_at: at(min) });
const out = (id, min, content = 'hi', sender_type = 'User') => ({ id, message_type: 'outgoing', private: false, content, sender_type, created_at: at(min) });
const run = (msgs, o = {}) => evaluate({ conv: { id: 1, labels: [], ...(o.conv || {}) }, msgs, st: o.st, now: T0 + (o.nowMin ?? 20) * 60_000, delayMin: o.delay ?? 12, cfg: { ...cfg, ...(o.cfg || {}) }, kind: o.kind });

test('waits until the random delay is over', () => {
  assert.equal(run([inc(1, 0)], { nowMin: 11 }).action, 'wait');
  assert.equal(run([inc(1, 0)], { nowMin: 13 }).action, 'check-draft');
});
test('ignoreDelay (dry run) skips the waiting', () => assert.equal(run([inc(1, 0)], { nowMin: 1, cfg: { ignoreDelay: true } }).action, 'check-draft'));
test('a human reply after the customer message skips without handoff', () => {
  const r = run([inc(1, 0), out(2, 5)]);
  assert.deepEqual([r.action, r.reason], ['skip', 'human-replied']);
});
test('private notes and activities are ignored', () => {
  const msgs = [inc(1, 0), { ...out(2, 5), private: true }, { id: 3, message_type: 'activity', created_at: at(6) }];
  assert.equal(run(msgs).action, 'check-draft');
});
test('complaint words: whole word, case-insensitive, phrases, other languages', () => {
  for (const c of ['I want a REFUND now', 'please cancel my order', 'it is a Truffa!', 'what the fuck', 'this is a rip   off', 'Ask Sue']) assert.equal(run([inc(1, 0, c)]).reason, 'complaint-word', c);
  for (const c of ['refunded?', 'issue with my pursue', 'thanks']) assert.notEqual(run([inc(1, 0, c)]).reason, 'complaint-word', c);
});
test('several customer messages in a row are no longer a reason to hand over', () => {
  assert.equal(run([inc(1, 0), inc(2, 1), inc(3, 2)]).action, 'check-draft');
  assert.equal(run([inc(1, 0), out(2, 1), inc(3, 2), inc(4, 3), inc(5, 4), inc(6, 5)]).action, 'check-draft');
});
test('ai-handover label goes to a human', () => assert.equal(run([inc(1, 0)], { conv: { labels: ['ai-handover-billing'] } }).reason, 'ai-handover'));
test('customer messages older than the max age are left alone', () => assert.equal(run([inc(1, 0)], { nowMin: 25 * 60 }).reason, 'too-old'));
test('a finished conversation is not processed twice for the same message', () => assert.equal(run([inc(1, 0)], { st: { msgId: 1, done: true } }).reason, 'done'));
// A customer message after our auto-reply starts a new normal cycle. The caller (run.js) re-rolls the delay,
// clears outcome/done and calls evaluate again, so the second step below uses the state it leaves behind.
const afterReply = (o = {}) => ({ msgId: 1, outcome: 'sent', done: true, autoReplies: 1, ...o });
const reset = (o = {}) => ({ msgId: 1, outcome: undefined, done: false, autoReplies: 1, ...o });
const thread = [inc(1, 0), out(2, 12), inc(3, 30)];
test('customer writes again after an auto-reply: a new cycle starts, not a handoff', () => {
  const r = run(thread, { st: afterReply(), nowMin: 31 });
  assert.deepEqual([r.action, r.lastIn.id], ['new-cycle', 3]);
});
test('new cycle behaves like a first message: waits for its delay, then checks the draft', () => {
  assert.equal(run(thread, { st: reset(), nowMin: 35, delay: 12 }).action, 'wait');          // 5 min after the new message
  assert.equal(run(thread, { st: reset(), nowMin: 43, delay: 12 }).action, 'check-draft');   // 13 min after it
});
test('new cycle: the complaint-word check also covers the new message', () => {
  const msgs = [inc(1, 0), out(2, 12), inc(3, 30, 'this is a rip off')];
  assert.equal(run(msgs, { st: afterReply(), nowMin: 31 }).action, 'new-cycle');             // the check runs after the delay, like for a first message
  assert.deepEqual([run(msgs, { st: reset(), nowMin: 50 }).action, run(msgs, { st: reset(), nowMin: 50 }).reason], ['handoff', 'complaint-word']);
});
test('new cycle: a human reply to the new message skips, a too-old message is left alone', () => {
  assert.equal(run([...thread, out(4, 35)], { st: afterReply(), nowMin: 40 }).reason, 'human-replied');
  assert.equal(run(thread, { st: afterReply(), nowMin: 30 + 25 * 60 }).reason, 'too-old');
});
test('auto-reply limit: the next customer message after N auto-replies goes to a human', () => {
  const r = run(thread, { st: afterReply({ autoReplies: 15 }), nowMin: 31 });
  assert.deepEqual([r.action, r.reason], ['handoff', 'auto-reply-limit']);
  assert.equal(run(thread, { st: afterReply({ autoReplies: 14 }), nowMin: 31 }).action, 'new-cycle');
});
test('auto-reply limit is configurable and old state without a counter counts as one reply', () => {
  assert.equal(run(thread, { st: afterReply({ autoReplies: 2 }), cfg: { maxAutoReplies: 2 }, nowMin: 31 }).reason, 'auto-reply-limit');
  assert.equal(run(thread, { st: afterReply({ autoReplies: undefined }), nowMin: 31 }).action, 'new-cycle');
  assert.equal(run(thread, { st: afterReply({ autoReplies: undefined }), cfg: { maxAutoReplies: 1 }, nowMin: 31 }).reason, 'auto-reply-limit');
});
test('auto-reply limit does not hand over a message a human already answered', () => {
  assert.equal(run([...thread, out(4, 35)], { st: afterReply({ autoReplies: 15 }), nowMin: 40 }).reason, 'human-replied');
});
test('a conversation already handed to a human stays with them', () => {
  const r = run(thread, { st: { msgId: 1, outcome: 'handed', done: true }, nowMin: 31 });
  assert.deepEqual([r.action, r.reason], ['skip', 'handed-earlier']);
});
test('a send that went out but was not confirmed is completed, not repeated', () => {
  const r = run([inc(1, 0), out(2, 12, 'the draft', 'User')], { st: { msgId: 1, sentHash: sha('the draft') } });
  assert.equal(r.action, 'complete');
});
test('draft judging', () => {
  const lastIn = inc(1, 0);
  assert.equal(judgeDraft(null, lastIn).reason, 'no-draft');
  assert.equal(judgeDraft({ content: '  ', source: 'ai', created_at: at(5) }, lastIn).reason, 'no-draft');
  assert.equal(judgeDraft({ content: 'x', source: 'external', created_at: at(5) }, lastIn).reason, 'human-draft');
  assert.equal(judgeDraft({ content: 'x', source: 'ai', created_at: at(-5) }, lastIn).reason, 'draft-older-than-message');
  const ok = judgeDraft({ content: 'x', source: 'ai', created_at: at(1), updated_at: at(1) }, lastIn);
  assert.deepEqual([ok.action, ok.text], ['send', 'x']);
});
test('parsers', () => {
  assert.equal(parseKinds('5001:messenger,5002:comment').get(5002), 'comment');
  assert.equal(romeParts(Date.parse('2026-11-05T07:30:00Z')).hour, 8);
});

// Human joined: an outgoing message between our last auto-reply and the new customer message that our token did not send.
const ours = (o = {}) => afterReply({ sentHashes: [sha('AUTO')], sentHash: sha('AUTO'), ...o });
const withHuman = [inc(1, 0), out(2, 12, 'AUTO', 'User'), out(3, 20, 'a human wrote this', 'User'), inc(4, 30)];
test('human joined: a message we did not send after our auto-reply hands over, even with a new customer message pending', () => {
  const r = run(withHuman, { st: ours(), nowMin: 31 });
  assert.deepEqual([r.action, r.reason, r.lastIn.id], ['handoff', 'human-joined', 4]);
});
test('human joined takes priority over the auto-reply limit; a human message BEFORE our auto-reply does not count', () => {
  assert.equal(run(withHuman, { st: ours({ autoReplies: 15 }), nowMin: 31 }).reason, 'human-joined');
  const early = [inc(1, 0), out(2, 5, 'a human wrote this'), out(3, 12, 'AUTO'), inc(4, 30)];
  assert.equal(run(early, { st: ours(), nowMin: 31 }).action, 'new-cycle');
});
test('human joined: only our own messages in between means a normal new cycle', () => {
  assert.equal(run([inc(1, 0), out(2, 12, 'AUTO'), out(3, 20, 'AUTO'), inc(4, 30)], { st: ours({ sentHashes: [sha('AUTO')] }), nowMin: 31 }).action, 'new-cycle');
});
test('human joined: old state with one sentHash still recognises our message; without any hash only later messages count', () => {
  assert.equal(run([inc(1, 0), out(2, 12, 'AUTO'), inc(4, 30)], { st: afterReply({ sentHash: sha('AUTO') }), nowMin: 31 }).action, 'new-cycle');
  assert.equal(run(withHuman, { st: afterReply({ sentAt: T0 + 13 * 60_000 }), nowMin: 31 }).reason, 'human-joined');
  assert.equal(run([inc(1, 0), out(2, 12, 'AUTO'), inc(4, 30)], { st: afterReply({ sentAt: T0 + 13 * 60_000 }), nowMin: 31 }).action, 'new-cycle');
});
test('human joined: a handoff is only for a new message after our auto-reply (a first message is unaffected)', () => {
  assert.equal(run([inc(1, 0)], { nowMin: 13 }).action, 'check-draft');
});

test('the same customer writes 4 times and gets 4 automatic replies (default cap is 15)', () => {
  const draftText = (n) => `AUTO-${n}`;
  let st, msgs = [], clock = 0, replies = 0, id = 0;
  for (let n = 1; n <= 4; n++) {
    clock += 60; msgs.push(inc(++id, clock));
    let ev = evaluate({ conv: { id: 1, labels: [] }, msgs, st, now: T0 + (clock + 1) * 60_000, delayMin: 12, cfg: { ...cfg, maxAutoReplies: undefined } });
    if (ev.action === 'new-cycle') { st.outcome = undefined; st.done = false; ev = evaluate({ conv: { id: 1, labels: [] }, msgs, st, now: T0 + (clock + 1) * 60_000, delayMin: 12, cfg: { ...cfg, maxAutoReplies: undefined } }); }
    assert.equal(ev.action, 'wait', `message ${n}`);
    clock += 13;
    ev = evaluate({ conv: { id: 1, labels: [] }, msgs, st, now: T0 + (clock + 1) * 60_000, delayMin: 12, cfg: { ...cfg, maxAutoReplies: undefined } });
    assert.equal(ev.action, 'check-draft', `message ${n}`);
    assert.equal(judgeDraft({ content: draftText(n), source: 'ai', updated_at: at(clock) }, ev.lastIn).action, 'send');
    msgs.push(out(++id, clock, draftText(n))); replies++;
    st = { msgId: ev.lastIn.id, outcome: 'sent', done: true, autoReplies: replies, sentHash: sha(draftText(n)), sentHashes: [sha(draftText(n))] };
  }
  assert.equal(replies, 4);
});

// ---- comments without a draft, purchase words ----
const ai = (min = 1) => ({ content: 'x', source: 'ai', created_at: at(min), updated_at: at(min) });
const judge = (text, draft = null, kind = 'comment', c = {}) => judgeDraft(draft, inc(1, 0, text), { kind, cfg: { ...cfg, ...c } });
test('comment without a draft: short chat is resolved as no-reply-needed (nothing is handed over)', () => {
  for (const text of ['Public Library', 'nice one', 'Thanks!', 'ok']) assert.equal(judge(text).action, 'no-reply-needed', text);
  assert.equal(judge('Public Library \u{1F609}').action, 'no-reply-needed');
});
test('comment without a draft: a question mark (also full-width and inverted) means handoff no-draft', () => {
  for (const text of ['Is it open?', 'is it open\uFF1F', '\u00BFcuando llega', 'really ? ok']) { const r = judge(text); assert.deepEqual([r.action, r.reason], ['handoff', 'no-draft'], text); }
});
test('comment without a draft: length limit counts characters (emoji = 1), 60 is allowed, 61 is not', () => {
  assert.equal(judge('a'.repeat(60)).action, 'no-reply-needed');
  assert.equal(judge('a'.repeat(61)).reason, 'no-draft');
  assert.equal(judge('a'.repeat(59) + '\u{1F609}').action, 'no-reply-needed');          // 60 characters
  assert.equal(judge('a'.repeat(60) + '\u{1F609}').reason, 'no-draft');                 // 61 characters
  assert.equal(judge('a'.repeat(30), null, 'comment', { noReplyMax: 20 }).reason, 'no-draft');
});
test('comment without a draft: empty text and whitespace are not judged, they go to a human', () => {
  for (const text of ['', '   ']) assert.equal(judge(text).reason, 'no-draft');
  assert.equal(judgeDraft(null, { id: 1, message_type: 'incoming', created_at: at(0) }, { kind: 'comment', cfg }).reason, 'no-draft');   // no text at all
});
test('comment without a draft: a complaint word is never closed', () => {
  assert.notEqual(judge('refund please').action, 'no-reply-needed');
  assert.equal(run([inc(1, 0, 'refund please')], { kind: 'comment' }).reason, 'complaint-word');        // evaluate hands it over first
});
test('messenger (or unknown kind) without a draft: handoff no-draft as before', () => {
  for (const kind of ['messenger', 'unknown']) { const r = judge('nice one', null, kind); assert.deepEqual([r.action, r.reason], ['handoff', 'no-draft'], kind); }
  const none = judgeDraft(null, inc(1, 0, 'nice one'), { cfg });                                   // kind not given
  assert.deepEqual([none.action, none.reason], ['handoff', 'no-draft']);
});
test('comment with a draft: the draft rules are unchanged (short text does not matter)', () => {
  assert.equal(judge('nice one', ai()).action, 'send');
  assert.equal(judge('nice one', { content: 'x', source: 'external', created_at: at(1) }).reason, 'human-draft');
});
test('purchase words (comments): always a handoff purchase-mention, before the draft is looked at', () => {
  for (const c of ['Where can I buy this', 'do you do WHOLESALE', 'wholesale!']) assert.deepEqual([run([inc(1, 0, c)], { kind: 'comment' }).action, run([inc(1, 0, c)], { kind: 'comment' }).reason], ['handoff', 'purchase-mention'], c);
  assert.equal(run([inc(1, 0, 'nice'), inc(2, 1, 'where can i buy')], { kind: 'comment' }).reason, 'purchase-mention');   // any customer message counts
});
test('purchase words: whole words only, and complaint words keep priority', () => {
  assert.notEqual(run([inc(1, 0, 'wholesaler')], { kind: 'comment' }).reason, 'purchase-mention');
  assert.equal(run([inc(1, 0, 'refund where can i buy')], { kind: 'comment' }).reason, 'complaint-word');
});
test('purchase words do not apply to messenger, unknown kind or an empty list', () => {
  for (const kind of ['messenger', 'unknown', undefined]) assert.equal(run([inc(1, 0, 'where can i buy')], { kind }).action, 'check-draft', String(kind));
  assert.equal(run([inc(1, 0, 'where can i buy')], { kind: 'comment', cfg: { purchaseRe: complaintRegex([]) } }).action, 'check-draft');
  assert.equal(run([inc(1, 0, 'where can i buy')], { kind: 'comment', cfg: { purchaseRe: undefined } }).action, 'check-draft');
});
