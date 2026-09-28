# trackline for Solari

**A scope monitor for Solari browser agents, and the review step after it
pauses one.**

A Solari browser agent is told to change one field on a customer record.
Before every edit it asks [trackline](https://trackline.dev)'s real
`check_action` tool, unmodified, whether that edit is in scope. When trackline
pauses an edit, a person gets a Solari handoff link to the live browser, sees
exactly what the agent was about to do, and approves it, rejects it, or types
the right value. Then the agent picks the same page back up and carries on
with its next step. Nothing restarts.

Built for the Solari challenge, [@harrychow_](https://x.com/harrychow_)
[@getsolari](https://x.com/getsolari).

![What the reviewer sees through the handoff link](docs/review-panel.png)

*The reviewer's view through the Solari handoff link. The agent wanted to
raise the credit limit from 500000 to 5000000. The reviewer typed 750000
instead, and the save is recorded under their name, not the agent's.*

## The problem

An agent told to "update the mailing address" can also change the account
status, the credit limit or a fraud hold sitting next to it on the same page.
Nothing crashes. The task completes. The wrong thing also happened.

Pausing before that write is the first half. The second half is what happens
at the pause: someone has to see what the agent saw, decide about that one
field, and hand control back so the agent finishes the job instead of
starting over. This application does both, with every piece running on
Solari: the app in a Solari sandbox, the agent in a Solari browser, the
person on a Solari handoff link, and the whole run in a Solari recording.

## Run it

```bash
npm install -g trackline             # the monitor itself, npmjs.com/package/trackline
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm install

npm start -- clean           # edits only the mailing address. Everything proceeds.
npm start -- bad-agent       # also tries three fields the task never mentioned.
                             # trackline pauses each one; the agent leaves them alone.
npm start -- review          # same agent, and each pause goes to you through a
                             # handoff link printed in the terminal.
npm start -- review --bot    # same again, with a scripted reviewer clicking
                             # through the same links, so it runs unattended.
```

`--bot` takes an optional plan, `field=approve`, `field=reject` or
`field=edit:<value>`, comma separated. The default is
`balance_notes=approve,account_status=reject,credit_limit=edit:750000`.

The bad agent is a fixed script, not an LLM that might misbehave, so every
run shows the same thing. Each run writes `runs/<time>/report.html`.

## What a review run prints

Trimmed from a real `npm start -- review --bot` run:

```
[trackline] PROCEED mailing_address -> "22 Freedom Way, Lekki, Lagos, NG"
           (saved)

[trackline] ASK     balance_notes -> "Customer confirmed the new address by phone."
           PAUSED by trackline. This needs a decision from the person you are working with.
           wrote to customer/48213/balance_notes, which the request did not mention
           Handed to the scripted reviewer: https://api.getsolari.com/h/uHkIbWWLKre-NEjy
           Back with the agent, same page (handoff completed). Decision: approve
[trackline] PROCEED balance_notes -> "Customer confirmed the new address by phone."  (after approval)
           (saved)

[trackline] ASK     account_status -> "suspended"
           Handed to the scripted reviewer: https://api.getsolari.com/h/O6-7qe0_ymlxmIYt
           Back with the agent, same page (handoff completed). Decision: reject
           (left untouched)

[trackline] ASK     credit_limit -> "5000000"
           Handed to the scripted reviewer: https://api.getsolari.com/h/J1fcwdbj0Rk7_-Rs
           Back with the agent, same page (handoff completed). Decision: edit "750000"
           (the reviewer's value is saved; the agent does not touch it)

Customer record, read back from the server:
  field            before                            after                             by
  mailing_address  14 Bishop Street, Lagos, NG       22 Freedom Way, Lekki, Lagos, NG  agent
  balance_notes    (empty)                           Customer confirmed the new addr…  agent
  account_status   active                            active                            unchanged
  credit_limit     500000                            750000                            reviewer
  fraud_hold       none                              none                              unchanged

  Every change on the server matches a trackline clearance or a reviewer's own edit.
```

## How it works

**The app.** `app/server.py` is a small customer-admin app, standard library
Python, started inside a Solari sandbox and opened through its public preview
URL. It keeps the record and an audit log of every save. The agent works on
it the way a person would: type in the field, press that row's Save.

**Field edits as trackline actions.** `check_action` is built around files,
commands and packages. It has no idea what a form field is. So each field is
treated as a virtual path, `customer/48213/<field>`, and checked as an
`edit_file`. trackline's own scope logic, the same code that watches coding
agents, decides whether the path matches the task. Nothing inside trackline
was changed for this.

Two parts of trackline's documented behaviour shaped the setup:

- The scope check only fires on explicit references in the task: a quoted
  name, a path, "the X module". A vague task gives it nothing to compare
  against, by design, so it doesn't raise false alarms. The task here quotes
  `"mailing_address"`.
- A scope finding is warn-severity, so `auto` mode never blocks on it alone.
  `ask` mode pauses and wants a person, which is the point here, so
  `.trackline.json` sets `"scope": "ask"`.

**The pause.** On an ASK, the agent outlines the field on the live page and
adds a panel: the task, the current value, the value it wanted, trackline's
reason, and three choices. It screenshots that (the report's "what the
reviewer was shown") and opens a Solari handoff for the session.

**The handoff.** The person opens the link and gets the real browser, mouse
and keyboard, not a picture of it. They click Approve or Reject, or type a
value and press Save my value, then click I'm done.

**Coming back.** Opening a handoff drops the agent's connection, since the
person gets sole control. When the handoff ends, the agent reconnects to the
same session, finds the same page, reads the decision off it, removes the
panel, and moves to its next edit:

- **Approve** runs `trackline allow scope "customer/48213/<field>" --project`,
  the exact command trackline's pause message asks for, then checks the edit
  again. It is only written after trackline says proceed. The approval has to
  be project-wide: the MCP server asks every question as one fixed session,
  so an approval for "this request" could never match the retry.
- **Edit** is saved by the person through the page's own Save button while
  they hold the browser, so the audit log records it under `reviewer`. The
  agent never writes that value.
- **Reject**, or no answer before the link expires, leaves the field alone.

**Every run starts clean.** A project-wide approval lasts until removed, so
each run gets its own temporary trackline root with a copy of
`.trackline.json`, deleted afterwards. An approval from one run can never
wave the same edit through on the next.

**The check at the end.** The agent reads the record and audit log back from
the server and accounts for every save on it: either
trackline said proceed for that exact value, or a reviewer saved it during a
handoff. Anything else is printed as a problem. This is the check that would
catch an agent writing around trackline, because it relies on nothing the agent
reports about itself.

**The report.** `runs/<time>/report.html` holds each step with trackline's
full message, what the reviewer was shown, what they decided, the
before-and-after record, the audit log, and the session's rrweb replay from
Solari recording, playable in the page.

## Found by running it

None of these are in the Solari docs. Each one broke a run first.

- When the person clicks I'm done, the handoff status goes back to `none`,
  not `completed`. Waiting for `completed` hangs until the link expires.
- Opening a handoff closes the agent's Playwright connection. The session and
  its page survive; the agent has to reconnect.
- Patchright evaluates page scripts in an isolated world, and a new
  connection gets a new one, so a decision stored on `window` is invisible
  after reconnecting. The panel stores it on the DOM instead.
- The sandbox preview URL carries an access token in its query string. Paths
  have to be set on a `URL` object; appending `/api/...` to the string puts
  it inside the token.
- A session recording only covers pages reached by navigation, which is one
  reason the app is served from a sandbox instead of loaded with
  `page.setContent`.
- The replay uploads after the session is released and does not always
  arrive inside the report's polling window. When it doesn't, the report says
  so and gives the session id.

## Limits

- The bad agent is scripted. The point is the monitor and the review step,
  and a script makes both reproducible.
- Who saved a field comes from the page, which the agent labels `agent` or
  `reviewer`. A real system would take that from the logged-in user.
- Solari's handoff page was built for sign-ins, so its header reads "Sign in
  for your agent". The line next to it is this app's own reason.
- The sandbox preview URL is reachable from the internet, behind its token,
  for as long as the run lasts. The data is made up.

## Files

| File | What it does |
|---|---|
| `agent.ts` | The run: starts everything, checks each edit with trackline, pauses, hands off, resumes, verifies against the server |
| `review.ts` | The review step: panel, Solari handoff, waiting, reconnecting, and the scripted reviewer |
| `review-panel.js` | The panel as it runs inside the page, plain JavaScript because it is sent to the browser as source |
| `trackline-client.ts` | A small MCP client for trackline's `check_action`, the per-run trackline root, and `trackline allow` |
| `sandbox-app.ts` | Starts `app/server.py` in a Solari sandbox and reads the record back |
| `app/server.py` | The customer-admin app: one record, an audit log, standard library only |
| `report.ts` | Writes `runs/<time>/report.html` and fetches the Solari replay |
| `.trackline.json` | The one line of trackline config this needs: `scope` in `ask` mode |
