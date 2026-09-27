/**
 * A minimal MCP client for trackline's `check_action` tool.
 *
 * trackline speaks MCP over stdio. This spawns `trackline mcp --root <dir>`
 * once and keeps it alive for the whole session, sending one
 * `tools/call` per action and reading back one JSON-RPC response per line.
 *
 * check_action's schema is built around files, commands and packages, not
 * browser actions. The Solari adapter (agent.ts) maps each editable field on
 * the page to a virtual path — customer/<id>/<field> — and calls
 * check_action as an `edit_file` against that path. trackline's real scope
 * logic, unmodified, decides whether the field matches the stated task.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { createInterface } from "node:readline"
import type { Writable, Readable } from "node:stream"

export type Verdict = "proceed" | "stop" | "ask"

export interface CheckResult {
  verdict: Verdict
  reason?: string
  raw: unknown
}

const REQUEST_TIMEOUT_MS = 5000

export class TracklineClient {
  // stderr is "inherit" below (trackline's own diagnostics show live in this
  // process's terminal), not piped, so the real type has stderr: null, not
  // Readable — ChildProcessWithoutNullStreams was wrong and tsc caught it.
  private proc: ChildProcessByStdio<Writable, Readable, null>
  private nextId = 1
  private pending = new Map<number, (msg: any) => void>()
  private spawnError: Error | null = null

  constructor(root: string) {
    this.proc = spawn("trackline", ["mcp", "--root", root], {
      stdio: ["pipe", "pipe", "inherit"],
    })
    // Without this, a missing `trackline` binary (ENOENT) surfaces only as a
    // hung send() with no explanation. Caught by running this file with
    // trackline uninstalled: initialize() hung indefinitely until this was
    // added.
    this.proc.on("error", (err) => {
      this.spawnError = err
    })
    const rl = createInterface({ input: this.proc.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const resolve = this.pending.get(msg.id)
      if (resolve) {
        this.pending.delete(msg.id)
        resolve(msg)
      }
    })
  }

  private send(method: string, params: unknown): Promise<any> {
    if (this.spawnError) {
      return Promise.reject(
        new Error(
          `trackline CLI not found or failed to start (${this.spawnError.message}). ` +
            `Install it first: npm install -g trackline`
        )
      )
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `trackline did not respond to "${method}" within ${REQUEST_TIMEOUT_MS}ms. ` +
              `Is "trackline" installed and on PATH? (npm install -g trackline)`
          )
        )
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  async initialize(): Promise<void> {
    await this.send("initialize", { protocolVersion: "2025-06-18" })
  }

  /**
   * Ask whether editing `virtualPath` to `newValue` is in scope for `task`.
   * Maps onto check_action's `edit_file` action, the closest real fit for
   * "this field is changing" in a schema built for files.
   */
  async checkFieldEdit(virtualPath: string, newValue: string, task: string): Promise<CheckResult> {
    const res = await this.send("tools/call", {
      name: "check_action",
      arguments: {
        action: "edit_file",
        path: virtualPath,
        content: newValue,
        task,
      },
    })
    // Real shape (engine/internal/mcp/server.go `render`): decision lives in
    // structuredContent.decision ("proceed" | "stop" | "ask"); content[0].text
    // is the human-readable message, and is what we show in the demo output.
    const structured = res?.result?.structuredContent
    const text = res?.result?.content?.[0]?.text ?? JSON.stringify(res)
    return {
      verdict: (structured?.decision ?? "ask") as Verdict,
      reason: text,
      raw: res,
    }
  }

  close(): void {
    this.proc.stdin.end()
    this.proc.kill()
  }
}
