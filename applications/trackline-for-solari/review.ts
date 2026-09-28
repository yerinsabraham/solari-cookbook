/**
 * The part after the pause: show a person what the agent saw, let them
 * decide about the one field, and give the browser back to the agent.
 *
 * 1. The agent marks the paused field on the live page and adds a small panel:
 *    trackline's reason, the current value, the value the agent wanted, and
 *    three choices (approve, reject, or type the right value).
 * 2. It opens a Solari handoff for the session. The person gets a short link
 *    to the real browser, not a screenshot, with mouse and keyboard.
 * 3. They choose and click "I'm done". The agent reattaches to the same
 *    session and the same page, reads the decision, and carries on with the
 *    next step. Nothing restarts.
 *
 * Solari has no SDK method for handoffs yet, so those calls are plain HTTP,
 * the same three endpoints examples/browser-login-handoff-ts uses. Opening a
 * handoff drops the agent's own connection (the person gets sole control),
 * which is why reattach() exists.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "patchright-core"
import { Solari } from "@solarisdk/browser"

const API = "https://api.getsolari.com"
const PANEL_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "review-panel.js"), "utf-8")

export type Decision = "approve" | "reject" | "edit" | "none"

export interface ReviewRequest {
  field: string
  label: string
  current: string
  proposed: string
  task: string
  reason: string
}

/** Pixel boxes of the panel's controls, in page coordinates, for the scripted reviewer. */
export interface PanelBoxes {
  approve: Box
  reject: Box
  ownValue: Box
  ownSave: Box
}
type Box = { x: number; y: number; width: number; height: number }

async function api<T>(apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

/**
 * Put the review panel on the live page and mark the paused field. Everything
 * the person needs to decide is on the page they are about to see, so the
 * handoff link on its own is enough context.
 */
export async function showReviewPanel(page: Page, req: ReviewRequest): Promise<PanelBoxes> {
  await page.evaluate(`(${PANEL_SOURCE})(${JSON.stringify(req)})`)

  const box = async (sel: string): Promise<Box> => {
    const b = await page.locator(sel).boundingBox()
    if (!b) throw new Error(`review panel control ${sel} is not visible`)
    return b
  }
  return {
    approve: await box("#tl-approve"),
    reject: await box("#tl-reject"),
    ownValue: await box("#tl-own-value"),
    ownSave: await box("#tl-own-save"),
  }
}

export async function clearReviewPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("tl-review")?.remove()
    document.querySelectorAll("[data-tl-flag]").forEach((el) => {
      ;(el as HTMLElement).style.outline = ""
      el.removeAttribute("data-tl-flag")
    })
  })
}

export async function readDecision(page: Page): Promise<{ decision: Decision; value?: string }> {
  const raw = await page.evaluate(() => document.body.dataset.tlDecision ?? null)
  if (!raw) return { decision: "none" }
  return JSON.parse(raw)
}

export interface Handoff {
  shortUrl: string
  expiresAt: string
}

export async function openHandoff(apiKey: string, sessionId: string, reason: string): Promise<Handoff> {
  // `reason` is the line the person reads at the top of the link before they
  // decide anything, so it says what is being asked, in one sentence.
  return api<Handoff>(apiKey, "POST", `/sessions/${encodeURIComponent(sessionId)}/handoff`, { reason })
}

/** Poll until the person clicks "I'm done", or the link expires. */
export async function waitForHandoff(apiKey: string, sessionId: string, expiresAt: string): Promise<string> {
  const deadline = new Date(expiresAt).getTime() + 15_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const { status } = await api<{ status: string }>(
      apiKey,
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/handoff`
    )
    if (status === "pending") continue
    // Once the person clicks "I'm done" the status reads "none" again (no
    // handoff open), not "completed". Seen by running it; so "none" before the
    // deadline means they finished, and after it means the link ran out.
    if (status === "none") return Date.now() < new Date(expiresAt).getTime() ? "completed" : "expired"
    return status
  }
  return "timed out"
}

/**
 * Get the agent back onto the same page after a handoff. The Playwright
 * connection that opened the handoff is gone, but the session and its page
 * are not: the person was looking at them.
 */
export async function reattach(wsEndpoint: string, origin: string): Promise<{ browser: Browser; page: Page }> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const browser = await chromium.connect(wsEndpoint)
      const page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().startsWith(origin))
      if (page) return { browser, page }
      await browser.close().catch(() => {})
      lastErr = new Error(`reattached, but no page from ${origin} was open in the session`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw lastErr
}

/**
 * A scripted reviewer, for runs with nobody at the keyboard. It opens the same
 * handoff link a person would get, in a second Solari browser, and clicks and
 * types on the streamed view the way a person does. It never touches the
 * agent's page directly, so the round trip it exercises is the real one.
 */
export async function scriptedReviewer(
  apiKey: string,
  link: string,
  boxes: PanelBoxes,
  plan: { decision: Exclude<Decision, "none">; value?: string },
  screenshotPath?: string
): Promise<void> {
  const solari = new Solari({ apiKey })
  const reviewer = await solari.launch()
  try {
    const page = await reviewer.newPage()
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(link, { waitUntil: "load" })
    // Wait for the socket to open and a few frames to land on the canvas.
    await page.waitForFunction(() => /Type your|Your agent cannot/.test(document.getElementById("msg")?.textContent ?? ""), null, {
      timeout: 20_000,
    })
    await page.waitForTimeout(2500)

    // Page coordinates on the agent's side -> screen coordinates on the canvas.
    const canvas = await page.evaluate(() => {
      const c = document.getElementById("c") as HTMLCanvasElement
      const r = c.getBoundingClientRect()
      return { left: r.left, top: r.top, sx: r.width / c.width, sy: r.height / c.height }
    })
    const click = async (b: Box) => {
      await page.mouse.click(canvas.left + (b.x + b.width / 2) * canvas.sx, canvas.top + (b.y + b.height / 2) * canvas.sy)
      await page.waitForTimeout(600)
    }

    if (plan.decision === "approve") await click(boxes.approve)
    else if (plan.decision === "reject") await click(boxes.reject)
    else {
      await click(boxes.ownValue)
      await page.keyboard.type(plan.value ?? "", { delay: 60 })
      await page.waitForTimeout(400)
      await click(boxes.ownSave)
      await page.waitForTimeout(1500)
    }
    await page.waitForTimeout(1000)
    if (screenshotPath) await page.screenshot({ path: screenshotPath })
    await page.click("#done")
    await page.waitForTimeout(1500)
  } finally {
    await reviewer.close()
  }
}
