---
name: Prospect Outreach
owner: growth
participants: [researcher, copywriter]
trigger:
  type: manual
definitionOfDone: >
  A research brief on the prospect exists AND a drafted outreach email grounded
  in that brief has been queued for sending (pending human approval).
approvals: [send_email]
budget:
  tokens: 300000
  usd: 5
  turns: 6
---
Run outbound prospecting for a single named prospect.

1. Dispatch the researcher to produce a concise brief on the prospect: what they
   do, recent signals, likely pain points Acme addresses, and the best contact.
2. Once the brief exists, dispatch the copywriter to draft a short outreach email
   grounded in the brief and queue it for sending.
3. Verify both artifacts exist, then report a summary up to the CEO.

The actual send is gated behind human approval — never auto-send.
