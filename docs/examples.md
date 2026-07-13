# Examples

Three working teams, each teaching a different part of the runtime. Validate
or run any of them from the repo root:

```bash
ravel validate --dir examples/<name>
ravel serve --dir examples/<name>          # console + API
ravel run "<Process Name>" --dir examples/<name>   # one-shot, no server
```

## `examples/acme` — a small multi-agent org

The simplest complete org: a CEO who delegates to a Growth Manager, who in
turn dispatches a Researcher and a Copywriter.

```
acme/
  agent.md                    # Acme CEO — sets direction, delegates, escalates
  growth/
    agent.md                  # Growth Manager
    researcher/agent.md        # produces a prospect research brief
    copywriter/
      agent.md                # drafts outreach email from the brief
      tools.json               # grants send_email as "ask" (gated)
  processes/
    prospect-outreach.process.md
```

**What it teaches:**
- The minimal org-chart shape (root → manager → two workers).
- A **gated action**: `send_email` is `policy: "ask"` — the copywriter drafts
  and queues the email, but nothing sends until a human approves the
  resulting Proposal. The process's `definitionOfDone` explicitly requires
  the draft to be *queued*, not sent.
- Budget/turn caps at the process level (`tokens: 300000`, `usd: 5`,
  `turns: 6`) bounding the whole run, independent of any per-agent budget.

Run it: `ravel run "Prospect Outreach" --dir examples/acme`, then `ravel
proposals list` to see the queued send.

## `examples/harbor` — a support-ops firm (queue-draining, fan-out, QA gate)

A fictional customer-support operations company: a Managing Director over two
branches — **Support Ops** (ticket triage → drafting → QA) and **Sales** (lead
qualification → scoping/pricing).

```
harbor/
  agent.md                              # Managing Director
  support/
    agent.md                            # Support Ops Manager
    triage/agent.md                     # classifies + risk-flags tickets
    kb-writer/agent.md                  # drafts responses + KB articles
    qa-reviewer/agent.md                # independent QA, PASS/FAIL verdict
    tools.json                          # grants release_responses as "ask"
  sales/
    agent.md                            # Sales Lead
    sdr/agent.md                        # qualifies + researches leads
    solutions/
      agent.md                         # scopes + prices, drafts proposal
      tools.json                        # grants send_proposal as "ask"
  processes/
    new-client-quote.process.md         # sales: lead → priced proposal
    resolve-ticket-batch.process.md     # support: tickets → QA'd responses
```

**What it teaches:**
- **Multi-stage handoff with a QA gate**: `Resolve Ticket Batch` runs
  triage → draft → independent review, and explicitly loops a **FAIL**
  verdict back to the writer rather than releasing around it — the same
  pattern you'd use for any produce → review → ship pipeline.
- **Risk routing**: the triage agent flags tickets that must never be
  auto-answered (legal threats, security reports) and routes them out for a
  human, rather than the review step catching it after the fact.
- **Two independently schedulable processes** sharing one org — `support` and
  `sales` are siblings under the same root, each with its own gated action
  (`release_responses`, `send_proposal`) and its own approval requirement.
- **Escalation rules in the manager's own prompt** (`escalation:` frontmatter)
  — a Managing Director or manager surfaces specific situations to a human
  rather than the orchestrator enforcing it in code.

Run it: `ravel run "Resolve Ticket Batch" --dir examples/harbor --file
./tickets.json`.

## `examples/plugin-demo` — the smallest complete plugin

A two-agent team whose only job is to exercise the **team plugin** mechanism
end to end: one in-process tool and one gated tool paired with its executor
action.

```
plugin-demo/
  agent.md                   # Demo Lead — owns the one process
  processes/
    jot.process.md            # record a note, then propose publishing it
  scribe/
    agent.md                  # calls the plugin's tools
    plugin.ts                 # definePlugin({ tools, actions })
    tools.json                # grants note_append (auto), publish_note (ask)
```

`plugin.ts` defines two tools:
- **`note_append`** (`policy: "auto"`) — an ordinary in-process MCP tool;
  runs immediately when the scribe calls it.
- **`publish_note`** (`policy: "ask"`) — a **gated tool**: the call is denied
  at runtime and queued as a Proposal. A same-named entry in the plugin's
  `actions` array is what actually runs once a human approves it — this
  pairing (tool + action, same name) is the entire gated-action mechanism;
  see [authoring-teams.md](./authoring-teams.md#plugints--team-code-tools--gated-actions)
  for the code.

**What it teaches:** the complete round-trip for a plugin's own gated action
— tool call → denied → Proposal queued → human approves → executor runs the
plugin's `actions` handler — with nothing else in the team to distract from
it. This is the pattern to copy when a plugin needs its own consequential,
human-approved side effect (as opposed to `send_email`/`send_proposal`/
`deliver_to_client` in the other two examples, which are placeholder gated
tools with no real handler — illustrative of the *policy*, not the full
plugin mechanism).

Run it: `ravel run "Jot" --dir examples/plugin-demo --input text="hello"`,
then `ravel proposals list`.
