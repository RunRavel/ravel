---
name: Jot
owner: demo-lead
participants: [scribe]
trigger:
  type: manual
definitionOfDone: >
  The scribe has appended the given note to team memory and proposed publishing it
  (a proposal is queued for human approval).
budget:
  usd: 2
  turns: 6
---
Record and propose-publish a note, end-to-end through the team plugin.

1. Dispatch the **scribe** to `note_append({ text })` with the note from the run
   inputs (`text`), then `publish_note({ text })` to propose publishing it.
2. Once the scribe reports done, mark the process done with a one-line summary
   (the publish is gated — it's now waiting in the Proposals queue).

Inputs: `text` — the note to record (defaults to a friendly hello if omitted).
