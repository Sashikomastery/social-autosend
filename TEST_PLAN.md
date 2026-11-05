# Test plan

1. `npm test` passes (fake Commslayer, no network).
2. Create the secrets and variables from the README. Leave `SEND_ENABLED` unset.
3. Run the workflow by hand with `dry_run` ticked and `ignore_delay` ticked. Check in the log, per open conversation: would send / would hand over (with the reason) / skipped. Check the "sender types seen" line to confirm that human replies are recognised.
4. Review at least 10 "would send" conversations in Commslayer by hand: is the draft right, is the conversation really unanswered?
5. Optional: run once with `probe_conversation_id` set to a TEST conversation to confirm Commslayer keeps the attributes `auto_sent` and `needs_human` (the log prints the keys before and after).
6. Set `SEND_ENABLED=true` for a short supervised window and watch the first real runs.
