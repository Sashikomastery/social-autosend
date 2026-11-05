import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
function run(extraEnv, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autosend-'));
  if (state) { fs.mkdirSync(path.join(dir, '.state')); fs.writeFileSync(path.join(dir, '.state/state.json'), JSON.stringify({ convs: state, events: [], alerted: {}, reportedDate: '', expiryReminded: '' })); }
  const writesFile = path.join(dir, 'writes.json');
  const r = spawnSync('node', ['--import', path.join(root, 'test/fake-fetch.mjs'), path.join(root, 'src/run.js')], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, WRITES_FILE: writesFile, COMMSLAYER_TOKEN_SOCIAL: 'TOKEN-XYZ', SLACK_BOT_TOKEN: 'SLACK-XYZ', SLACK_USER_ID: 'U1', INBOX_IDS: '5001,5002',
      INBOX_KINDS: '5002:comment', AGENT_CHAIN: '777,9002,9003', COMPLAINT_WORDS: 'refund,sue', MAX_CALLS: '60', ...extraEnv },
  });
  return { out: r.stdout + r.stderr, code: r.status, writes: JSON.parse(fs.readFileSync(writesFile, 'utf8')), dir };
}

test('real run: sends the due draft, hands the complaint over (first agent missing -> fallback), leaves the rest', () => {
  const r = run({ SEND_ENABLED: 'true', GITHUB_EVENT_NAME: 'schedule' });
  assert.equal(r.code, 0, r.out);
  const sends = r.writes.filter((w) => w[0] === 'SEND');
  assert.deepEqual(sends, [['SEND', 101, 'DRAFT-TEXT-101']]);                                     // the draft, unchanged, only for 101
  assert.ok(r.writes.some((w) => w[0] === 'PATCH' && w[1] === 101 && w[2].status === 'resolved'));
  assert.ok(r.writes.some((w) => w[0] === 'PATCH' && w[1] === 101 && w[2].custom_attributes?.auto_sent === true && w[2].custom_attributes.keep === 1));
  assert.ok(r.writes.some((w) => w[0] === 'PATCH' && w[1] === 102 && w[2].assignee_id === 9002));  // position 1 answered 404 -> position 2
  assert.ok(r.writes.some((w) => w[0] === 'PATCH' && w[1] === 102 && w[2].custom_attributes?.needs_human === true));
  assert.ok(!r.writes.some((w) => w[1] === 103 || w[1] === 104));                                  // waiting / human-replied: untouched
  for (const secret of ['SECRET-CUSTOMER-TEXT', 'DRAFT-TEXT', 'TOKEN-XYZ', 'SLACK-XYZ', 'REFUND']) assert.ok(!r.out.includes(secret), `log leaks ${secret}`);
  // second run with the saved state: nothing is sent twice
  const state = fs.readFileSync(path.join(r.dir, '.state/state.json'), 'utf8');
  assert.ok(!state.includes('SECRET') && !state.includes('DRAFT-TEXT'));
});

test('customer writes again after an auto-reply: a new cycle sends; at the limit it goes to a human with one Slack DM; a complaint still goes to a human', () => {
  const sent = (n) => ({ msgId: 2011, outcome: 'sent', done: true, autoReplies: n, delayMin: 12, touched: Date.now(), seenActivity: 'old', sentHash: 'x' });
  const r = run({ SEND_ENABLED: 'true', GITHUB_EVENT_NAME: 'schedule', SCENARIO: 'repeat', MAX_AUTO_REPLIES: '3' }, { 201: sent(1), 202: sent(3), 203: sent(1) });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.writes.filter((w) => w[0] === 'SEND'), [['SEND', 201, 'DRAFT-TEXT-201']]);                       // 201: second auto-reply
  assert.ok(r.writes.some((w) => w[0] === 'PATCH' && w[1] === 201 && w[2].status === 'resolved'));
  assert.ok(r.writes.some((w) => w[0] === 'PATCH' && w[1] === 202 && w[2].custom_attributes?.needs_human === true));   // 202: limit of 3 reached
  assert.ok(r.writes.some((w) => w[0] === 'PATCH' && w[1] === 203 && w[2].custom_attributes?.needs_human === true));   // 203: complaint word in the new message
  const st = JSON.parse(fs.readFileSync(path.join(r.dir, '.state/state.json'), 'utf8')).convs;
  assert.equal(st[201].autoReplies, 2);
  assert.deepEqual([st[202].outcome, st[202].reason], ['handed', 'auto-reply-limit']);
  assert.deepEqual([st[203].outcome, st[203].reason], ['handed', 'complaint-word']);
  assert.match(r.out, /conversation 202: assigned to chain position 2 \(auto-reply-limit\)/);
  assert.equal(r.writes.filter((w) => w[0] === 'SLACK').length, 3, 'DMs: fallback x2 (202, 203) and the limit alert (202)');
});

test('dry run changes nothing in Commslayer', () => {
  const r = run({ SEND_ENABLED: 'true', DRY_RUN: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', IGNORE_DELAY: 'true' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.writes.filter((w) => w[0] !== 'SLACK'), []);
  assert.match(r.out, /would send/);
  assert.ok(!fs.existsSync(path.join(r.dir, '.state/state.json')));
});

test('scheduled run does nothing while SEND_ENABLED is not true', () => {
  const r = run({ GITHUB_EVENT_NAME: 'schedule' });
  assert.match(r.out, /disabled/);
  assert.deepEqual(r.writes, []);
});
