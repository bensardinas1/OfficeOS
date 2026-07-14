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

// Two items:
//  - "brickell:gateway:row" is a FLAT (non-clustered) tile — its detail pane
//    renders a real per-row delete button (`del:msg:` token) for each member.
//    Row-level ids are real (e0..e11), so the server-hydrated acted map
//    (keyed by those emailIds) matches after a reload — this drives the
//    acted/undo/reload assertions.
//  - "brickell:handled" is a sender-CLUSTERED tile (jobType handled) — its
//    detail pane renders a per-sender "delete all" button
//    (`data-delete-sender`, posts /senders/delete-all). In fake-connector
//    mode that route always returns a canned emailIds: ["f1","f2","f3"],
//    matched: 3, trashed: 3 — which don't match this tile's seeded ids, so
//    we only assert the resulting notice, not row-level dimming (see B1.8 brief).
function seed(dataDir) {
  const now = new Date().toISOString();
  const rowMembers = Array.from({ length: 12 }, (_, i) => ({
    subject: `[TEST] message ${i}`, from: "noise@example.com", fromName: "Noise Co",
    emailId: `e${i}`, receivedAt: now, automated: true, conversationId: null,
  }));
  const clusterMembers = Array.from({ length: 3 }, (_, i) => ({
    subject: `[CLUSTER] message ${i}`, from: "bulk@example.com", fromName: "Bulk Co",
    emailId: `c${i}`, receivedAt: now,
  }));
  // A 3-member human conversation (single provider conversationId, 3 distinct
  // senders) — exercises the handled tile's "Conversations" section alongside
  // its existing sender-cluster ("Bulk senders") section built from clusterMembers.
  const conv = [
    { subject: "Path Peptides underwriting", from: "luis@brickell.example", fromName: "Luis", emailId: "h0", receivedAt: now, conversationId: "cv-1", automated: false },
    { subject: "RE: Path Peptides underwriting", from: "mckenna@partner.example", fromName: "McKenna", emailId: "h1", receivedAt: now, conversationId: "cv-1", automated: false },
    { subject: "RE: Path Peptides underwriting", from: "boarding@partner.example", fromName: "Boarding", emailId: "h2", receivedAt: now, conversationId: "cv-1", automated: false },
  ];
  writeFileSync(join(dataDir, "world-model.json"), JSON.stringify({
    generatedAt: now,
    accounts: { brickell: { status: "ok", lastTickAt: now, label: "Brickell", accountType: "business" } },
    items: [
      {
        id: "brickell:gateway:row", jobType: "gateway", account: "brickell",
        title: "12 need a reply or decision", subtitle: "", status: "ok",
        display: { accountLabel: "Brickell" },
        group: { rootCause: "row", members: rowMembers, moreCount: 0 },
        source: [], proposedActions: [], lastChanged: now,
      },
      {
        id: "brickell:handled", jobType: "handled", account: "brickell",
        title: "3 need a reply or decision", subtitle: "", status: "ok",
        display: { accountLabel: "Brickell" },
        group: { rootCause: "handled", members: [...clusterMembers, ...conv], moreCount: 0 },
        source: [], proposedActions: [], lastChanged: now,
      },
    ],
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

test("row delete → working → acted → undo → survives reload", async ({ page }) => {
  await page.goto(base);
  await expect(page.locator(".sechdr .seclabel")).toContainText("Brickell");

  // Open the flat tile's detail pane, scroll it, arm a per-row delete.
  //
  // NOTE vs. the brief: Playwright's click() always scrolls its target into view
  // first (this happens unconditionally, even with force: true — it's not gated by
  // the "actionability checks" force skips). The row delete button sits inside the
  // first message row near the top of the scrollable message list, so scrolling
  // deep (e.g. scrollTop=300) pushes it out of view and Playwright's own
  // scroll-into-view resets the pane's scroll as a side effect of the click itself
  // — that would falsely look like the app failing to preserve scroll. Verified via
  // an in-page (non-Playwright) button.click() that the app's own draw()-triggered
  // restoreDetailScroll() does correctly preserve scrollTop across the re-render.
  // So: scroll to an offset where the row (and its .del button) is still fully
  // within the pane's viewport — Playwright's scroll-into-view is then a no-op —
  // which lets the assertion observe the app's actual preservation behavior.
  await page.locator('[data-detail="brickell:gateway:row"]').click();
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

  // confirm → Working… → acted row with Undo
  await page.locator("aside.detail .del.armed").first().click();
  await expect(page.locator("aside.detail .msg.acted").first()).toBeVisible();
  await expect(page.locator('[data-undo-acted]').first()).toBeVisible();
  const scrollAfterConfirm = await pane.evaluate(el => el.scrollTop);
  expect(scrollAfterConfirm).toBe(scrollTarget);                     // still preserved post-confirm

  // reload — acted state must survive (served from the action log)
  await page.reload();
  await page.locator('[data-detail="brickell:gateway:row"]').click();
  await expect(page.locator("aside.detail .msg.acted").first()).toBeVisible();

  // undo the acted row
  const actedBefore = await page.locator("aside.detail .msg.acted").count();
  expect(actedBefore).toBeGreaterThan(0);
  await page.locator('[data-undo-acted]').first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(actedBefore - 1);

  // and the undo also survives a reload
  await page.reload();
  await page.locator('[data-detail="brickell:gateway:row"]').click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(actedBefore - 1);
});

test("cluster delete-all posts the intent-level /senders/delete-all", async ({ page }) => {
  await page.goto(base);
  await expect(page.locator(".sechdr .seclabel")).toContainText("Brickell");

  // Open the sender-clustered tile's detail pane and drive its "delete all"
  // button — this is the button rewired by B1.8 from data-delete to
  // data-delete-sender, posting /senders/delete-all instead of /messages/delete.
  await page.locator('[data-detail="brickell:handled"]').click();
  const pane = page.locator("aside.detail");
  await expect(pane).toBeVisible();
  await expect(page.locator("aside.detail .del").first()).toHaveAttribute("data-delete-sender", "brickell");

  await page.locator("aside.detail .del").first().click();          // arm
  await expect(page.locator("aside.detail .del.armed").first()).toContainText("Confirm");
  await page.locator("aside.detail .del.armed").first().click();    // confirm

  // Fake mode's deleteBySenderFn always returns matched: 3, trashed: 3 —
  // canned, independent of how many ids the seeded cluster actually has.
  await expect(page.locator(".notice")).toContainText("Moved 3 to Trash (3 matched)");
});

test("multi-sender conversation: one group, bulk delete + undo via the bar", async ({ page }) => {
  await page.goto(base);

  // The handled tile's detail pane splits into two sections: "Conversations"
  // (human mail, grouped by provider conversationId — cv-1's 3 messages from
  // 3 different senders render as ONE group) and "Bulk senders" (the existing
  // clusterMembers, unaffected — see previous test).
  await page.locator('[data-detail="brickell:handled"]').click();
  const pane = page.locator("aside.detail");
  await expect(pane).toBeVisible();
  await expect(pane.locator(".convgrp")).toHaveCount(1);
  await expect(pane.locator(".cghdr .cgname")).toContainText("Path Peptides underwriting");
  await expect(pane.locator(".cghdr .cgmeta")).toContainText("3 messages · 3 senders");

  // select the conversation → sticky bar appears. The bar (z-index 12) sits
  // ABOVE the pane's backdrop (10) and the pane itself (11), so the validated
  // flow is fully in-pane: check the box, then drive the bar directly while
  // the detail pane stays open throughout.
  await pane.locator('[data-select="conv:brickell:cv-1"]').check();
  const bar = page.locator(".bulkbar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("1 selected");

  // two-click bulk delete, pane still open
  await bar.locator("[data-bulk-delete]").click();
  await expect(bar.locator("[data-bulk-delete]")).toContainText("Confirm");
  await bar.locator("[data-bulk-delete]").click();
  await expect(page.locator(".notice")).toContainText(/Deleted 3 \(1 conversation\)/);

  // rows acted in the open pane; survives reload (real ids h0..h2 → server-derived)
  await expect(pane.locator(".msg.acted")).toHaveCount(3);
  await page.reload();
  await page.locator('[data-detail="brickell:handled"]').click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(3);

  // bulk undo the same conversation — again with the pane open
  await page.locator('aside.detail [data-select="conv:brickell:cv-1"]').check();
  await page.locator(".bulkbar [data-bulk-undo]").click();
  await page.locator(".bulkbar [data-bulk-undo]").click();
  await expect(page.locator(".notice")).toContainText(/restored 3/);
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(0);
  await page.reload();
  await page.locator('[data-detail="brickell:handled"]').click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(0);
});
