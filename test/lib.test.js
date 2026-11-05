import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, judgeDraft, complaintRegex, parseKinds, sha, romeParts } from '../src/lib.js';

const WORDS = 'refund,sue,cancel my order,rip off,truffa,fuck'.split(',');
const cfg = { complaintRe: complaintRegex(WORDS), maxAgeMs: 24 * 3600_000, ignoreDelay: false };
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
test('customer writes again after an auto-reply: handed to a human', () => {
  const r = run([inc(1, 0), out(2, 12), inc(3, 30)], { st: { msgId: 1, outcome: 'sent', done: true }, nowMin: 50 });
  assert.deepEqual([r.action, r.reason, r.event], ['handoff', 'replied-again', 'replied_again']);
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
