---
name: Resolve Ticket Batch
owner: support
participants: [triage, kb-writer, reviewer]
trigger:
  type: manual
definitionOfDone: >
  The ticket batch has been triaged (risk-flagged tickets routed out for a
  human), customer-ready responses drafted for every answerable ticket, passed
  independent QA (no critical issues), and the approved responses have been
  queued for release pending human approval.
approvals: [release_responses]
budget:
  usd: 10
  turns: 8
---
A batch of support tickets is ready to work. Take it from raw tickets to
QA-passed, release-ready responses.

1. Dispatch the **Triage Specialist** to classify the batch: category, tier,
   priority, risk flags, and answerable-from-docs, written to `shared/`.
   Risk-flagged tickets are routed out for a human — never auto-answered.
2. Dispatch the **Response Writer** to draft responses for the answerable
   tickets (and KB articles for recurring how-tos), grounded in the product
   docs in `shared/`.
3. Dispatch the **QA Reviewer** for independent review. If the verdict is
   FAIL, send the flagged drafts back to the writer and re-review before
   continuing — do not release around a failed QA.
4. Once QA passes, queue the responses for release.
5. Verify QA passed and every answerable ticket has a response, then report a
   summary up: counts by tier, anything escalated, and KB articles produced.

Never auto-release — sending to customers is gated on human approval.
