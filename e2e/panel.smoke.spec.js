import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let daemon, dir, port, base;

// OS-assigned ephemeral port. A hardcoded port would let a daemon orphaned by
// an aborted earlier run win the bind — our daemon exits 0 on EADDRINUSE, so
// the health check could then pass against the STALE process (wrong data dir).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function seed(dataDir) {
  const now = new Date().toISOString();
  const members = Array.from({ length: 12 }, (_, i) => ({
    subject: `[TEST] message ${i}`, from: "noise@example.com", fromName: "Noise Co",
    emailId: `e${i}`, receivedAt: now,
  }));
  writeFileSync(join(dataDir, "world-model.json"), JSON.stringify({
    generatedAt: now,
    accounts: { brickell: { status: "ok", lastTickAt: now, label: "Brickell", accountType: "business" } },
    items: [{
      id: "brickell:handled", jobType: "handled", account: "brickell",
      title: "12 need a reply or decision", subtitle: "", status: "ok",
      display: { accountLabel: "Brickell" },
      group: { rootCause: "handled", members, counts: { needsYou: 12, waiting: 0 }, moreCount: 0 },
      source: [], proposedActions: [], lastChanged: now,
    }],
  }, null, 2), "utf-8");
  writeFileSync(join(dataDir, "proposal-queue.json"), JSON.stringify({ proposals: [] }), "utf-8");
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "officeos-e2e-"));
  const dataDir = join(dir, "data"), configDir = join(dir, "config");
  mkdirSync(dataDir, { recursive: true }); mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "companies.json"), JSON.stringify({ companies: [
    { id: "brickell", name: "Brickell", accountType: "business", provider: "outlook", pollMinutes: 999 },
  ] }), "utf-8");
  writeFileSync(join(configDir, "account-types.json"), JSON.stringify({
    business: { jobTypes: { handled: {} } },
  }), "utf-8");
  seed(dataDir);
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  daemon = spawn("node", [join(root, "daemon", "daemon.js"), "--port", String(port), "--data-dir", dataDir, "--config-dir", configDir],
    { env: { ...process.env, OFFICEOS_FAKE_CONNECTORS: "1" }, windowsHide: true });
  // Wait for /health AND for the immediate first tick to finish (lastTickAt set).
  // The daemon runs one tick at startup regardless of pollMinutes; that tick can
  // broadcast an SSE "update" mid-flight. Waiting for lastTickAt before returning
  // (and before the page's EventSource ever connects) keeps that one-time broadcast
  // from racing our later interactions — pollMinutes: 999 means no tick fires again
  // for the rest of the test.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        const j = await r.json();
        if (j.lastTickAt) {
          // Stale-instance guard: prove we're talking to the child we spawned,
          // not some other daemon that happened to own the port.
          expect(j.pid).toBe(daemon.pid);
          return;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("daemon did not come up");
});

test.afterAll(() => {
  daemon?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("delete → working → acted → undo → survives reload", async ({ page }) => {
  await page.goto(base);
  await expect(page.locator(".sechdr .seclabel")).toContainText("Brickell");

  // Open details, scroll the pane, arm a per-cluster delete.
  //
  // NOTE vs. the brief: Playwright's click() always scrolls its target into view
  // first (this happens unconditionally, even with force: true — it's not gated by
  // the "actionability checks" force skips). The "Delete all" button sits in the
  // sender-group header at the top of the scrollable message list, so scrolling
  // deep (e.g. scrollTop=300) pushes it out of view and Playwright's own
  // scroll-into-view resets the pane's scroll as a side effect of the click itself
  // — that would falsely look like the app failing to preserve scroll. Verified via
  // an in-page (non-Playwright) button.click() that the app's own draw()-triggered
  // restoreDetailScroll() does correctly preserve scrollTop across the re-render.
  // So: scroll to an offset where the header (and its .del button) is still fully
  // within the pane's viewport — Playwright's scroll-into-view is then a no-op —
  // which lets the assertion observe the app's actual preservation behavior.
  await page.locator("button.detail").first().click();
  const pane = page.locator("aside.detail");
  await expect(pane).toBeVisible();
  const geo = await page.evaluate(() => {
    const p = document.querySelector("aside.detail"), d = document.querySelector("aside.detail .del");
    const pr = p.getBoundingClientRect(), dr = d.getBoundingClientRect();
    return { paneTop: pr.top, delTop: dr.top };
  });
  const scrollTarget = Math.max(0, Math.min(150, Math.floor(geo.delTop - geo.paneTop) - 10));
  expect(scrollTarget).toBeGreaterThan(0); // sanity: pane is actually tall enough to scroll
  await pane.evaluate((el, t) => { el.scrollTop = t; }, scrollTarget);
  await page.locator("aside.detail .del").first().click();          // arm
  await expect(page.locator("aside.detail .del.armed").first()).toContainText("Confirm");
  const scrollAfterArm = await pane.evaluate(el => el.scrollTop);
  expect(scrollAfterArm).toBe(scrollTarget);                         // scroll preserved exactly

  // confirm → Working… → acted rows with Undo
  await page.locator("aside.detail .del.armed").first().click();
  await expect(page.locator("aside.detail .msg.acted").first()).toBeVisible();
  await expect(page.locator('[data-undo-acted]').first()).toBeVisible();
  const scrollAfterConfirm = await pane.evaluate(el => el.scrollTop);
  expect(scrollAfterConfirm).toBe(scrollTarget);                     // still preserved post-confirm

  // reload — acted state must survive (served from the action log)
  await page.reload();
  await page.locator("button.detail").first().click();
  await expect(page.locator("aside.detail .msg.acted").first()).toBeVisible();

  // undo one member — server-side semantics: a cluster delete creates ONE
  // action-log entry covering all 12 members, so undoing any one member
  // clears the acted state for the whole entry (all 12), not just that row.
  const actedBefore = await page.locator("aside.detail .msg.acted").count();
  expect(actedBefore).toBeGreaterThan(0);
  await page.locator('[data-undo-acted]').first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(0);

  // and the undo also survives a reload
  await page.reload();
  await page.locator("button.detail").first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(0);
});
