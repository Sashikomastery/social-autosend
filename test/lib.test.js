import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, judgeDraft, complaintRegex, parseKinds, sha, romeParts } from '../src/lib.js';

const WORDS = 'refund,sue,cancel my order,rip off,truffa,fuck'.split(',');
const cfg = { complaintRe: complaintRegex(WORDS), maxAgeMs: 24 * 3600_000, ignoreDelay: false, maxAutoReplies: 5 };
const T0 = Date.parse('2026-11-05T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const inc = (id, min, content = 'hello') => ({ id, message_type: 'incoming', private: false, content, created_at: at(min) });
const out = (id, min, content = 'hi', sender_type = 'User') => ({ id, message_type: 'outgoing', private: false, content, sender_type, created_at: at(min) });
const run = (msgs, o = {}) => evaluate({ conv: { id: 1, labels: [], ...(o.conv || {}) }, msgs, st: o.st, now: T0 + (o.nowMin ?? 20) * 60_000, delayMin: o.delay ?? 12, cfg: { ...cfg, ...(o.cfg || {}) } });

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
test('three customer messages in a row go to a human', () => {
  assert.equal(run([inc(1, 0), inc(2, 1), inc(3, 2)]).reason, 'three-in-a-row');
  assert.equal(run([inc(1, 0), out(2, 1), inc(3, 2), inc(4, 3)]).action, 'check-draft');
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
test('new cycle: three customer messages in a row without a reply still go to a human', () => {
  const msgs = [inc(1, 0), out(2, 12), inc(3, 30), inc(4, 31), inc(5, 32)];
  assert.equal(run(msgs, { st: reset(), nowMin: 60 }).reason, 'three-in-a-row');
});
test('new cycle: a human reply to the new message skips, a too-old message is left alone', () => {
  assert.equal(run([...thread, out(4, 35)], { st: afterReply(), nowMin: 40 }).reason, 'human-replied');
  assert.equal(run(thread, { st: afterReply(), nowMin: 30 + 25 * 60 }).reason, 'too-old');
});
test('auto-reply limit: the next customer message after N auto-replies goes to a human', () => {
  const r = run(thread, { st: afterReply({ autoReplies: 5 }), nowMin: 31 });
  assert.deepEqual([r.action, r.reason], ['handoff', 'auto-reply-limit']);
  assert.equal(run(thread, { st: afterReply({ autoReplies: 4 }), nowMin: 31 }).action, 'new-cycle');
});
test('auto-reply limit is configurable and old state without a counter counts as one reply', () => {
  assert.equal(run(thread, { st: afterReply({ autoReplies: 2 }), cfg: { maxAutoReplies: 2 }, nowMin: 31 }).reason, 'auto-reply-limit');
  assert.equal(run(thread, { st: afterReply({ autoReplies: undefined }), nowMin: 31 }).action, 'new-cycle');
  assert.equal(run(thread, { st: afterReply({ autoReplies: undefined }), cfg: { maxAutoReplies: 1 }, nowMin: 31 }).reason, 'auto-reply-limit');
});
test('auto-reply limit does not hand over a message a human already answered', () => {
  assert.equal(run([...thread, out(4, 35)], { st: afterReply({ autoReplies: 5 }), nowMin: 40 }).reason, 'human-replied');
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
  assert.equal(run(withHuman, { st: ours({ autoReplies: 5 }), nowMin: 31 }).reason, 'human-joined');
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
