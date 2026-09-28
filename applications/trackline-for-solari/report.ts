/**
 * One self-contained HTML file per run: every step with trackline's verdict,
 * what the person was shown at each pause, what they decided, the record as
 * the server holds it before and after, and the Solari session replay.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Solari } from "@solarisdk/browser"
import type { CustomerState } from "./sandbox-app.ts"

export interface Step {
  n: number
  field: string
  from: string
  proposed: string
  verdict: string
  reason: string
  outcome: string
  /** True when the agent itself saved this field, after a trackline proceed. */
  agentWrote?: boolean
  screenshot?: string
  /** The scripted reviewer's own view of the handoff link, just before "I'm done". */
  reviewerView?: string
  handoff?: string
  decision?: string
  reviewerValue?: string
}

export interface RunSummary {
  mode: string
  task: string
  sessionId: string
  steps: Step[]
  before: CustomerState
  after: CustomerState
  replay: string | null
  unexplained: string[]
}

/**
 * The replay uploads after the session is released, so the first polls
 * usually 404. Same window as examples/browser-session-recording-py.
 */
export async function downloadReplay(solari: Solari, sessionId: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 15; attempt++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const bytes = await solari.sessions.downloadReplay(sessionId)
      return new TextDecoder().decode(bytes)
    } catch (err: any) {
      // The SDK retries internally and wraps the last failure, so the 404 can
      // be on the error itself or on its cause.
      if ((err?.status ?? err?.cause?.status) === 404) continue
      throw err
    }
  }
  return null
}

/** rrweb NDJSON -> a flat event array, whether a line holds one event or a batch. */
function replayEvents(ndjson: string): unknown[] {
  const out: unknown[] = []
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      if (Array.isArray(v)) out.push(...v)
      else if (Array.isArray(v?.events)) out.push(...v.events)
      else out.push(v)
    } catch {
      // a truncated last line is not worth failing the report over
    }
  }
  // A new tab starts on about:blank, and the recording starts with it. Begin
  // the replay at the first real page so it doesn't open on a white frame.
  const start = out.findIndex((e: any) => e?.type === 4 && e.data?.href && e.data.href !== "about:blank")
  return start > 0 ? out.slice(start) : out
}

const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const shown = (s: string) => (s === "" ? '<span class="dim">empty</span>' : esc(s))

export function writeReport(dir: string, run: RunSummary): string {
  const events = run.replay ? replayEvents(run.replay) : []

  const steps = run.steps
    .map((s) => {
      const img = s.screenshot
        ? `<figure><img alt="What the reviewer was shown for ${esc(s.field)}" src="data:image/png;base64,${readFileSync(s.screenshot).toString("base64")}"><figcaption>What the reviewer was shown</figcaption></figure>`
        : ""
      const view = s.reviewerView
        ? `<figure><img alt="The reviewer's view of the handoff link" src="data:image/png;base64,${readFileSync(s.reviewerView).toString("base64")}"><figcaption>The reviewer's view through the Solari handoff link, before clicking I'm done</figcaption></figure>`
        : ""
      const decision = s.decision
        ? `<p><b>Reviewer:</b> ${esc(s.decision)}${s.reviewerValue ? ` &rarr; ${esc(s.reviewerValue)}` : ""} <span class="dim">(handoff ${esc(s.handoff ?? "")})</span></p>`
        : ""
      const reason = s.reason
        .split("\n")
        .filter((l) => !l.startsWith("(checked against the project"))
        .join("\n")
        .trim()
      return `<section class="step v-${esc(s.verdict)}">
        <h3><span class="n">${s.n}</span> <code>${esc(s.field)}</code>: ${shown(s.from)} &rarr; ${shown(s.proposed)}
          <span class="pill">${esc(s.verdict.toUpperCase())}</span></h3>
        <pre>${esc(reason)}</pre>
        ${decision}
        <p class="outcome">${esc(s.outcome)}</p>
        ${img}
        ${view}
      </section>`
    })
    .join("\n")

  const rows = Object.keys(run.before.record)
    .map((f) => {
      const a = run.before.record[f]
      const b = run.after.record[f]
      const last = [...run.after.audit].reverse().find((e) => e.field === f)
      return `<tr class="${a === b ? "" : "changed"}"><td><code>${esc(f)}</code></td><td>${shown(a)}</td><td>${shown(b)}</td><td>${last ? esc(last.actor) : '<span class="dim">unchanged</span>'}</td></tr>`
    })
    .join("")

  const audit = run.after.audit
    .map((e) => `<tr><td>${esc(e.at)}</td><td><code>${esc(e.field)}</code></td><td>${shown(e.from)}</td><td>${shown(e.to)}</td><td>${esc(e.actor)}</td></tr>`)
    .join("")

  const check = run.unexplained.length
    ? `<p class="bad">${run.unexplained.length} change(s) on the server with no trackline clearance or reviewer decision:</p><ul>${run.unexplained.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
    : `<p class="good">Every change on the server matches a trackline clearance or a reviewer's own edit.</p>`

  const replay = events.length
    ? `<div id="player"></div>
      <script src="https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist/index.js"></script>
      <script>
        const events = ${JSON.stringify(events).replace(/</g, "\\u003c")};
        try {
          new rrwebPlayer({ target: document.getElementById("player"), props: { events, width: 960, height: 540, autoPlay: false } });
        } catch (e) {
          document.getElementById("player").textContent = "The replay could not be rendered here (" + e.message + "). " + events.length + " rrweb events are embedded in this file.";
        }
      </script>`
    : `<p class="dim">No replay: Solari had not uploaded the recording inside the polling window. It can be fetched later for session <code>${esc(run.sessionId)}</code>.</p>`

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>trackline-for-solari run</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist/style.css">
<style>
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; margin: 0; }
  main { max-width: 1000px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 10px; }
  h3 { font-size: 15px; margin: 0 0 8px; font-weight: 600; }
  .dim { color: #6b7280; font-style: italic; }
  .step { background: #fff; border: 1px solid #e5e7eb; border-left: 4px solid #9ca3af; border-radius: 6px; padding: 14px 16px; margin-bottom: 12px; }
  .v-proceed { border-left-color: #16a34a; } .v-ask { border-left-color: #d97706; } .v-stop { border-left-color: #dc2626; }
  .n { display: inline-block; width: 22px; height: 22px; border-radius: 11px; background: #111827; color: #fff; text-align: center; font-size: 12px; line-height: 22px; }
  .pill { font-size: 11px; padding: 2px 7px; border-radius: 10px; background: #f3f4f6; margin-left: 6px; }
  .v-proceed .pill { background: #dcfce7; color: #166534; } .v-ask .pill { background: #fef3c7; color: #92400e; }
  pre { background: #f3f4f6; padding: 10px; border-radius: 4px; white-space: pre-wrap; font-size: 12.5px; margin: 0 0 8px; }
  .outcome { font-weight: 600; margin: 6px 0 0; }
  figure { margin: 12px 0 0; } figure img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 4px; }
  figcaption { font-size: 12px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; background: #fff; font-size: 14px; }
  td, th { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tr.changed td { background: #fefce8; }
  .good { color: #166534; font-weight: 600; } .bad { color: #b91c1c; font-weight: 600; }
  #player { margin-top: 8px; }
  @media (max-width: 640px) { td, th { padding: 6px; font-size: 13px; } }
</style></head>
<body><main>
  <h1>trackline for Solari: ${esc(run.mode)} run</h1>
  <p>Task: <i>${esc(run.task)}</i><br><span class="dim">Solari session ${esc(run.sessionId.slice(0, 16))}…, ${new Date().toISOString()}</span></p>

  <h2>Steps</h2>
  ${steps}

  <h2>The record, read back from the server</h2>
  <table><tr><th>field</th><th>before</th><th>after</th><th>last saved by</th></tr>${rows}</table>
  ${check}

  <h2>Audit log</h2>
  ${audit ? `<table><tr><th>at</th><th>field</th><th>from</th><th>to</th><th>by</th></tr>${audit}</table>` : '<p class="dim">No saves.</p>'}

  <h2>Session replay</h2>
  ${replay}
</main></body></html>`

  const path = join(dir, "report.html")
  writeFileSync(path, html)
  return path
}
