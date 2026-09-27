# trackline for Solari

**A runtime scope monitor for browser agents.** Give a Solari-driven browser
agent a bounded task. Watch its actions through Solari. Ask
[trackline](https://trackline.dev)'s real `check_action` tool, unmodified,
whether each field edit is in scope, before it happens.

Built for the Solari challenge — [@harrychow_](https://x.com/harrychow_)
[@getsolari](https://x.com/getsolari).

## The problem

An agent given "update the mailing address" can, without anything crashing or
erroring, also update the account status, the credit limit, or a fraud hold
sitting right next to it on the same page. Nothing looks wrong. The task
completes. The wrong thing just also happened.

[trackline](https://github.com/yerinsabraham/trackline) already solves this
for coding agents, watching Claude Code, Codex and Cursor locally, and
production agents through their own OpenTelemetry traces. This is the same
tool, pointed at a new kind of agent: one that acts through a browser instead
of a filesystem.

## What's actually happening here, honestly

trackline's `check_action` MCP tool is built around files, edits, commands and
packages, not browser actions. It has no native concept of "typed into a form
field." So this adapter treats each editable field on the page as a virtual
path, `customer/<id>/<field>`, and calls `check_action` as an `edit_file`
against that path. trackline's real, unmodified scope-matching logic, the
same logic that protects a real codebase, decides whether the field matches
what the task said. Nothing inside trackline itself was changed for this.

Two things about trackline's actual, documented behaviour that shaped how
this demo is set up, found by reading the source, not assumed:

- **The scope check only fires on explicit references** in the task text, a
  quoted name, a path, "the X module." A vague task like "update the address"
  gives it nothing to compare against, deliberately, so it doesn't invent
  false alarms. The task here quotes the field name (`"mailing_address"`) for
  exactly that reason.
- **The scope check's own finding is warn-severity, by design**, so a full
  block ("auto" mode) never fires from it alone. `ask` mode is what actually
  pauses the action and requires a person's decision, so `.trackline.json`
  here sets `"scope": "ask"`. This isn't a workaround, it's the intervention
  mode the tool's own docs describe for judgement calls, as opposed to
  hard rules with no legitimate exception.

## The demo

A customer profile fixture: an editable mailing address, and three adjacent
fields with real weight if touched by mistake, account status, credit limit,
a fraud hold.

```bash
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm install
npm start -- clean       # edits only the mailing address. Everything proceeds.
npm start -- bad-agent   # edits the address, then tries account status and
                          # credit limit too. trackline pauses both, live,
                          # before either field is touched.
```

The bad-agent path is a scripted sequence, not an LLM occasionally
misbehaving, so the catch is reproducible on every run, not a lucky
recording.

## What it looks like

```
[trackline] PROCEED  mailing_address -> "22 Freedom Way, Lekki, Lagos, NG"
           Proceed.
           (field updated on the page)

[trackline] ASK      account_status -> "suspended"
           PAUSED by trackline. This needs a decision from the person you
           are working with.

           wrote to customer/48213/account_status, which the request did
           not mention
           (agent did not touch the field on the page, waiting on a person)

[trackline] ASK      credit_limit -> "5000000"
           PAUSED by trackline. This needs a decision from the person you
           are working with.
           (agent did not touch the field on the page, waiting on a person)
```

## Files

| File | What it does |
|---|---|
| `agent.ts` | Drives a real Solari browser session, runs the clean or bad-agent script, prints trackline's verdict before each field is touched |
| `trackline-client.ts` | A minimal MCP client over stdio for trackline's `check_action`, the mapping from a field edit to a virtual file path lives here |
| `fixture.html` | The customer profile page, rendered directly in the Solari browser via `page.setContent`, no server needed |
| `.trackline.json` | The one line of config this needed: `scope` in `ask` mode |

## Why this, not something built from scratch

Most of this already exists, shipped, real, open source: the scope-matching
logic, the intervention modes, the MCP interface. The new part is the
adapter, about 90 lines translating Solari's action stream into the shape
trackline already understands. That's the actual claim being made here: an
existing, working agent-safety tool extends to a new class of agent with an
adapter, not a rewrite.
