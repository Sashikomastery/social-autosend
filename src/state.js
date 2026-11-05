// State lives in .state/state.json, which the workflow keeps in the GitHub Actions cache. It is never committed.
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), '.state', 'state.json');
const empty = () => ({ convs: {}, events: [], alerted: {}, reportedDate: '', expiryReminded: '' });

export function loadState() {
  try { return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return empty(); }
}
export function saveState(state, now = Date.now()) {
  const keep = now - 4 * 86400_000;
  state.events = state.events.filter((e) => e.t >= keep);
  for (const [id, c] of Object.entries(state.convs)) if (c.touched && c.touched < now - 14 * 86400_000) delete state.convs[id];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state));
}
