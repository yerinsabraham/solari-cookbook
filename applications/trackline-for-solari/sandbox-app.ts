/**
 * Hosts app/server.py inside a Solari sandbox and hands back its public URL.
 *
 * The agent needs a real page to work on, not `page.setContent`: a real
 * server keeps the record the page saves to, so the end of a run can read back
 * what actually changed, and session recording only captures pages reached by
 * navigation.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SolariClient } from "@solarisdk/sdk"

const PORT = 8000
const CUSTOMER_ID = "48213"

export interface AuditEntry {
  at: string
  field: string
  from: string
  to: string
  actor: string
}

export interface CustomerState {
  initial: Record<string, string>
  record: Record<string, string>
  audit: AuditEntry[]
}

type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

export class SandboxApp {
  private constructor(
    private readonly sandbox: Sandbox,
    private readonly base: URL
  ) {}

  static async start(apiKey: string, appDir: string, timeoutMs: number): Promise<SandboxApp> {
    const client = new SolariClient({ apiKey })
    const sandbox = await client.sandboxes.create({ template: "base", timeoutMs })
    try {
      await sandbox.connect()
      await sandbox.files.write("/srv/app/server.py", readFileSync(join(appDir, "server.py"), "utf-8"))
      // commands.run waits for exit, so the server is backgrounded in a shell.
      await sandbox.commands.run("sh", {
        args: ["-c", `cd /srv/app && nohup python3 server.py ${PORT} >/srv/app/server.log 2>&1 &`],
      })
      const { url } = await sandbox.previewUrl(PORT)
      const app = new SandboxApp(sandbox, new URL(url))
      await app.waitUntilUp()
      return app
    } catch (err) {
      await sandbox.kill()
      throw err
    }
  }

  private async waitUntilUp(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(this.at("/healthz"))
        if (res.ok) return
      } catch {
        // preview route not live yet
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`the customer app in the sandbox never answered at ${this.host}/healthz`)
  }

  /**
   * The preview URL carries an access token in its query string, so paths are
   * set on a URL object rather than appended to the string.
   */
  private at(path: string): string {
    const u = new URL(this.base)
    u.pathname = path
    return u.toString()
  }

  get pageUrl(): string {
    return this.at("/")
  }

  /** Scheme and host only, safe to print. The full URL includes the token. */
  get host(): string {
    return this.base.origin
  }

  /** The server's copy of the record and its audit log. The source of truth. */
  async state(): Promise<CustomerState> {
    const res = await fetch(this.at(`/api/customers/${CUSTOMER_ID}`))
    if (!res.ok) throw new Error(`reading the record failed: HTTP ${res.status}`)
    return (await res.json()) as CustomerState
  }

  async stop(): Promise<void> {
    await this.sandbox.kill()
  }
}
