// The review panel, as it runs inside the agent's page. Plain JavaScript on
// purpose: it is sent to the browser as source (see showReviewPanel in
// review.ts), so it must not depend on anything the TypeScript toolchain adds.
(r) => {
  document.getElementById("tl-review")?.remove()
  document.querySelectorAll("[data-tl-flag]").forEach((el) => {
    el.style.outline = ""
    el.removeAttribute("data-tl-flag")
  })
  // The decision lives on the DOM, not on window: patchright evaluates in an
  // isolated world, and the agent reads this back over a new connection,
  // which gets a new one. The DOM is the only state both sides share.
  delete document.body.dataset.tlDecision

  const row = document.querySelector(`[data-row="${r.field}"]`)
  if (row) {
    row.style.outline = "3px solid #d97706"
    row.setAttribute("data-tl-flag", "")
  }

  const esc = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  const shown = (s) => (s === "" ? "<i>empty</i>" : `<b>${esc(s)}</b>`)
  const panel = document.createElement("aside")
  panel.id = "tl-review"
  panel.setAttribute(
    "style",
    "position:fixed;top:64px;right:24px;width:440px;background:#fff;border:2px solid #d97706;" +
      "border-radius:8px;padding:14px 16px;font:13px/1.45 system-ui,sans-serif;color:#111827;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.18);z-index:9999"
  )
  panel.innerHTML = `
    <div style="font-weight:700;font-size:15px;color:#92400e;margin-bottom:6px">trackline paused the agent</div>
    <div style="margin-bottom:8px">The task was: <i>${esc(r.task)}</i></div>
    <div style="margin-bottom:8px">The agent wants to change <b>${esc(r.label)}</b>
      from ${shown(r.current)} to ${shown(r.proposed)}.</div>
    <div style="background:#fffbeb;border-radius:4px;padding:6px 8px;margin-bottom:12px;color:#78350f">${esc(r.reason)}</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button id="tl-approve" style="flex:1;padding:8px;border:0;border-radius:4px;background:#15803d;color:#fff;font:inherit;font-weight:600;cursor:pointer">Approve ${esc(r.proposed || "empty")}</button>
      <button id="tl-reject" style="flex:1;padding:8px;border:0;border-radius:4px;background:#b91c1c;color:#fff;font:inherit;font-weight:600;cursor:pointer">Reject</button>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="tl-own-value" placeholder="or type the right value" style="flex:1;padding:7px 8px;border:1px solid #d1d5db;border-radius:4px;font:inherit">
      <button id="tl-own-save" style="padding:8px 10px;border:1px solid #0f2a44;border-radius:4px;background:#fff;color:#0f2a44;font:inherit;font-weight:600;cursor:pointer">Save my value</button>
    </div>
    <div id="tl-status" style="margin-top:10px;color:#374151"></div>`
  document.body.appendChild(panel)

  const status = panel.querySelector("#tl-status")
  const decide = (decision, value) => {
    document.body.dataset.tlDecision = JSON.stringify({ decision, value })
    panel.querySelectorAll("button, input").forEach((el) => (el.disabled = true))
    status.innerHTML = `Recorded: <b>${decision}</b>. Click <b>I'm done</b> at the top to hand the browser back.`
  }
  panel.querySelector("#tl-approve").addEventListener("click", () => decide("approve"))
  panel.querySelector("#tl-reject").addEventListener("click", () => decide("reject"))
  panel.querySelector("#tl-own-save").addEventListener("click", async () => {
    const value = panel.querySelector("#tl-own-value").value.trim()
    if (!value) {
      status.textContent = "Type a value first."
      return
    }
    // The person's own edit goes through the page's normal Save, recorded
    // on the server under "reviewer" (the agent set that before handing
    // over). The agent never writes this value itself.
    const input = document.getElementById(r.field)
    input.value = value
    document.getElementById(`save-${r.field}`).click()
    const savedRow = document.querySelector(`[data-row="${r.field}"]`)
    for (let i = 0; i < 50 && !savedRow.classList.contains("saved"); i++) {
      await new Promise((ok) => setTimeout(ok, 100))
    }
    decide("edit", value)
  })
}
