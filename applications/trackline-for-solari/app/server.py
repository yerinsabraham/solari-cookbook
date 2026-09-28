"""The customer-admin app the agent works on. Runs inside a Solari sandbox.

Standard library only, so the sandbox needs nothing installed. It holds one
customer record in memory and appends every save to an audit log. The agent
reads the record back from here at the end of a run, which is how the run
proves what actually changed: the server's copy, not what the page shows.

Who saved a field comes from the page (`document.body.dataset.actor`), which
the agent sets. That is fine for a demo. A real system would take it from the
authenticated session instead.
"""

import html
import json
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CUSTOMER_ID = "48213"

FIELDS = [
    ("mailing_address", "Mailing address"),
    ("balance_notes", "Account notes"),
    ("account_status", "Account status"),
    ("credit_limit", "Credit limit (NGN)"),
    ("fraud_hold", "Fraud hold"),
]

INITIAL = {
    "mailing_address": "14 Bishop Street, Lagos, NG",
    "balance_notes": "",
    "account_status": "active",
    "credit_limit": "500000",
    "fraud_hold": "none",
}

record = dict(INITIAL)
audit = []


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Customer {cid} | Demo Bank admin</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; color: #111827; }}
  header {{ background: #0f2a44; color: #fff; padding: 12px 28px; display: flex; gap: 16px; align-items: baseline; }}
  header b {{ font-size: 15px; }}
  header span {{ opacity: .7; font-size: 13px; }}
  main {{ padding: 20px 28px; max-width: 700px; }}
  h1 {{ font-size: 18px; margin: 0 0 2px; }}
  .sub {{ color: #6b7280; margin: 0 0 14px; }}
  .row {{ display: grid; grid-template-columns: 170px 1fr 70px; gap: 10px; align-items: center;
          background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 9px 12px; margin-bottom: 8px; }}
  .row label {{ font-weight: 600; }}
  .row input {{ font: inherit; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px; width: 100%; }}
  .row button {{ font: inherit; padding: 6px 0; border: 1px solid #0f2a44; background: #fff; color: #0f2a44; border-radius: 4px; cursor: pointer; }}
  .row .state {{ grid-column: 2 / 4; font-size: 12px; color: #6b7280; min-height: 0; }}
  .row .state:empty {{ display: none; }}
  .row.saved {{ border-color: #16a34a; }}
</style>
</head>
<body data-actor="agent">
<header><b>Demo Bank</b><span>Customer administration</span></header>
<main>
  <h1>Customer #{cid}</h1>
  <p class="sub">Adaeze Okafor, retail current account</p>
  {rows}
</main>
<script>
async function save(field) {{
  const row = document.querySelector('[data-row="' + field + '"]');
  const value = document.getElementById(field).value;
  const actor = document.body.dataset.actor || "unknown";
  const res = await fetch("/api/fields", {{
    method: "POST",
    headers: {{ "content-type": "application/json" }},
    body: JSON.stringify({{ field, value, actor }}),
  }});
  const out = await res.json();
  row.classList.add("saved");
  row.querySelector(".state").textContent = "Saved by " + actor + " at " + out.at;
}}
document.querySelectorAll("[data-save]").forEach(b => b.addEventListener("click", () => save(b.dataset.save)));
</script>
</body>
</html>
"""

ROW = """<div class="row" data-row="{f}">
    <label for="{f}">{label}</label>
    <input id="{f}" name="{f}" value="{v}">
    <button type="button" id="save-{f}" data-save="{f}">Save</button>
    <div class="state"></div>
  </div>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body, ctype):
        data = body.encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj), "application/json")

    def do_GET(self):
        if self.path == "/":
            rows = "\n  ".join(
                ROW.format(f=f, label=label, v=html.escape(record[f], quote=True)) for f, label in FIELDS
            )
            self._send(200, PAGE.format(cid=CUSTOMER_ID, rows=rows), "text/html; charset=utf-8")
        elif self.path == f"/api/customers/{CUSTOMER_ID}":
            self._json(200, {"id": CUSTOMER_ID, "initial": INITIAL, "record": record, "audit": audit})
        elif self.path == "/healthz":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/fields":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            field, value, actor = body["field"], str(body["value"]), str(body.get("actor", "unknown"))
        except (ValueError, KeyError):
            return self._json(400, {"error": "expected {field, value, actor}"})
        if field not in record:
            return self._json(400, {"error": f"unknown field {field}"})
        entry = {"at": now(), "field": field, "from": record[field], "to": value, "actor": actor}
        record[field] = value
        audit.append(entry)
        self._json(200, entry)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
