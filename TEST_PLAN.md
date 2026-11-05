# Test plan

1. `npm test` passes (fake Commslayer, no network).
2. Create the secrets and variables from the README. Leave `SEND_ENABLED` unset.
3. Run the workflow by hand with `dry_run` ticked and `ignore_delay` ticked. Check in the log, per open conversation: would send / would hand over (with the reason) / skipped. Check the "sender types seen" line to confirm that human replies are recognised.
4. Review at least 10 "would send" conversations in Commslayer by hand: is the draft right, is the conversation really unanswered?
5. Check the repeat-customer rules in the dry-run log: a conversation the customer wrote to again after an auto-reply shows `new cycle` and then would send / would hand over like any first message; one where a person had written after our auto-reply shows `would hand to a human (human-joined)`; a conversation that reached `MAX_AUTO_REPLIES` shows `would hand to a human (auto-reply-limit)`.
6. Optional: run once with `probe_conversation_id` set to a TEST conversation to confirm Commslayer keeps the attributes `auto_sent` and `needs_human` (the log prints the keys before and after).
7. Set `SEND_ENABLED=true` for a short supervised window and watch the first real runs.
