---
name: New Client Quote
owner: sales
participants: [sdr, solutions]
trigger:
  type: manual
definitionOfDone: >
  A qualification brief on the prospect exists, a scoped + priced proposal draft
  grounded in that brief exists (scope, channels, SLA, pricing math, assumptions,
  exclusions), and the proposal has been queued for sending pending human
  approval. If the lead is out of ICP, a documented disqualification with
  rationale also satisfies done.
approvals: [send_proposal]
budget:
  usd: 6
  turns: 6
---
An inbound lead has arrived. Turn it into a send-ready proposal (or a clean
disqualification).

1. Dispatch the **SDR** to qualify and research the prospect: who they are, the
   support signal, likely scope (channels, ticket volume, tier mix), ICP fit,
   and the best contact. If clearly out of ICP, the SDR recommends
   disqualifying — honor that and stop.
2. Once the brief exists, dispatch the **Solutions Consultant** to scope and
   price the engagement and draft the proposal, holding gross margin ≥ 15%
   (escalate to the MD if it can't be met).
3. Verify both the brief and a complete priced proposal exist, then queue the
   proposal for sending and report a one-paragraph summary up to the MD.

Never auto-send the proposal — the send is gated on human approval.
