// Slack DM through chat.postMessage. Messages contain ids and counts only. Never throws: a Slack problem must not stop a run.
export async function sendSlack(token, userId, text) {
  if (!token || !userId) { console.log('slack: not configured, message not sent'); return false; }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: userId, text }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) console.log(`slack: not delivered (${String(j.error || res.status).slice(0, 40)})`);
    return !!j.ok;
  } catch { console.log('slack: not delivered (network)'); return false; }
}
