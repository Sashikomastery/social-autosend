# social-autosend

Sends the AI drafts that Commslayer prepares for Facebook comments and Messenger DMs, 10-15 minutes after the customer wrote, and then resolves the conversation. It runs on GitHub Actions every 5 minutes. No AI is used at run time: the draft is sent exactly as it is.

This repository is public. It contains no customer data, and the logs only show conversation numbers and short codes.

## What it does in each run

For every open conversation in the inboxes listed in `INBOX_IDS`:

1. Waits until the customer's last message is older than a random delay of 10-15 minutes (chosen again for every new customer message that follows an auto-reply).
2. Does not send, and hands the conversation to a human, when:
   - the customer's messages contain a word from `COMPLAINT_WORDS`;
   - a label starting with `ai-handover` is present;
   - the customer wrote 3 or more messages in a row without a reply;
   - there is no draft, the draft is empty, or it is older than the customer's message.
3. Leaves the conversation alone (no handoff) when someone already replied, when a person wrote the draft, or when the customer's message is older than 24 hours (`MAX_AGE_HOURS`).
4. Otherwise it sends the draft, marks the conversation with the attribute `auto_sent: true`, and resolves it.
5. If the customer writes again after an auto-reply, that message starts a new cycle, exactly like a first message: a new random delay, the same checks (complaint words, 3 in a row, draft), then send and resolve. If a person (not our API token) wrote in the conversation between our last auto-reply and the new customer message, no new AI draft is sent: the conversation goes to a human with reason `human-joined`, keeping its assignee if it has one. Our own messages are recognised by the hash of the text we sent.
6. After `MAX_AUTO_REPLIES` auto-replies in the same conversation (default 5), the next customer message is handed to a human (reason `auto-reply-limit`) and you get one Slack DM.

Handing to a human means: assign it along the agent chain (`AGENT_CHAIN`) and set the attribute `needs_human: true`. A conversation that already has an assignee keeps it. An agent is skipped only if the account is missing or deactivated; if a handed conversation stays unanswered for 24 hours it moves to the next agent in the chain. Every fallback sends you a Slack DM.

The Commslayer API cannot add labels to a conversation, so `auto_sent` and `needs_human` are custom attributes, not labels.

## Setup

**Repository secrets** (Settings > Secrets and variables > Actions > Secrets)

| Name | What |
|---|---|
| `COMMSLAYER_TOKEN_SOCIAL` | Commslayer integration token (conversations, messages, drafts: read and write; account) |
| `SLACK_BOT_TOKEN` | Slack bot token, scope `chat:write` (and `im:write` if the DM does not open) |

**Repository variables** (same page, Variables tab)

| Name | Example / value |
|---|---|
| `INBOX_IDS` | `5001,5002,5003,5004` |
| `INBOX_KINDS` | `5001:messenger,5002:comment,5003:messenger,5004:comment` |
| `AGENT_CHAIN` | agent ids in order, e.g. `9002,9003,9004` |
| `SLACK_USER_ID` | your Slack member id (`U...`) |
| `COMPLAINT_WORDS` | comma separated list, whole words, case-insensitive; phrases allowed |
| `SEND_ENABLED` | leave it unset or `false` until you are ready. `true` turns on real sending |
| `MAX_AGE_HOURS` | optional, default 24 |
| `MAX_AUTO_REPLIES` | optional, default 5: auto-replies per conversation before a human takes over (a whole number of 1 or more) |

## Turn it on and off

- **Off (default):** `SEND_ENABLED` is not `true`. Scheduled runs exit at once and do nothing.
- **On:** set `SEND_ENABLED` to `true`. The next scheduled run sends for real.
- **Off again:** set `SEND_ENABLED` to `false`, or disable the workflow in the Actions tab.
- **Dry run:** Actions > social-autosend > Run workflow, with `dry_run` ticked. Nothing is changed in Commslayer. Tick `ignore_delay` to also see conversations that are still inside the delay. A summary (ids only) is sent to you on Slack.

## Reading the logs

Lines look like `conversation 7289: sent` or `conversation 7290: skipped (human replied)`. Codes you may see: `would send`, `would hand to a human (complaint-word | ai-handover | three-in-a-row | auto-reply-limit | human-joined | no-draft | draft-older-than-message)`, `customer wrote again after the auto-reply: new cycle`, `skipped (human replied | too-old | human-draft | done)`, `waiting until the delay is over`, `assigned to chain position N`, `needs_human attribute: ok`, `auto_sent attribute: ok`. At the end of a run: the number of API calls and, in dry runs, a summary by decision.

## Slack messages

- Daily at 08:30 Rome time: totals for the previous day (auto-sent split by comments and Messenger, handed to humans, customers who replied again, average delay, errors). Nothing is sent on a quiet day.
- Immediately: API error, token rejected (401/403), fallback chain used, repeated failures, conversation unanswered 24 hours with nobody left in the chain.
- One month before the Commslayer token expires (read from the API), a reminder.

## Notes

- State (conversation ids, delays, outcomes, no texts) is kept in the GitHub Actions cache, never in the repository. If the cache is lost, the script checks the conversation's messages before sending, so it does not reply twice.
- The workflow never runs on pull requests.
- GitHub may delay scheduled runs by several minutes, and it disables scheduled workflows after 60 days without any repository activity: push a small commit now and then.
- Tests: `npm test` (no network; uses a fake Commslayer).
