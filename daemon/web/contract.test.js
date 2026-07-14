import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "app.js"), "utf-8");
const render = readFileSync(join(here, "render.js"), "utf-8");

describe("panel render↔handler contract", () => {
  it("app.js handles every interactive data-attr the cards emit", () => {
    for (const attr of ["data-approve", "data-dismiss", "data-ack", "data-select", "data-bulk-approve", "data-detail", "data-detail-close", "data-collapse"]) {
      assert.match(app, new RegExp(`\\[${attr}\\]`), `app.js must select [${attr}]`);
    }
  });
  it("render.js emits the action data-attrs app.js posts on", () => {
    for (const attr of ["data-approve", "data-dismiss", "data-ack", "data-route", "data-detail", "data-collapse", "data-detail-close"]) {
      assert.match(render, new RegExp(attr), `render.js must emit ${attr}`);
    }
  });
  it("the acknowledge POST path in app.js matches the API route shape", () => {
    assert.match(app, /\/items\/\$\{encodeURIComponent\([^)]*\)\}\/acknowledge/);
  });
  it("app.js lazy-loads message bodies the detail panel asks for", () => {
    assert.match(render, /data-body-for=/, "render must emit data-body-for placeholders");
    assert.match(app, /\/messages\//, "app must fetch /messages/:id/body");
    assert.match(app, /data-body-for/, "app must fill the body placeholders");
  });
  it("app handles the undo action the snackbar emits", () => {
    assert.match(render, /data-undo/, "render must emit the undo button");
    assert.match(app, /\[data-undo\]/, "app must select [data-undo]");
  });
  it("app handles delete and killlist actions the cards emit", () => {
    for (const attr of ["data-delete", "data-killlist"]) {
      assert.match(render, new RegExp(attr), `render must emit ${attr}`);
      assert.match(app, new RegExp(`\\[${attr}\\]`), `app must select [${attr}]`);
    }
  });
  it("app handles the click-to-expand body action", () => {
    assert.match(render, /data-loadbody/, "render must emit data-loadbody for large tiles");
    assert.match(app, /\[data-loadbody\]/, "app must select [data-loadbody]");
  });
  it("app handles the run-triage action", () => {
    assert.match(render, /data-run-triage/, "render must emit data-run-triage");
    assert.match(app, /\[data-run-triage\]/, "app must select [data-run-triage]");
  });
  it("app handles the triage-window mode radios", () => {
    assert.match(render, /data-triage-mode/, "render must emit data-triage-mode");
    assert.match(app, /\[data-triage-mode\]/, "app must select [data-triage-mode]");
  });
  it("app handles delete-and-kill and per-item undo", () => {
    for (const attr of ["data-delkill", "data-undo-acted"]) {
      assert.match(render, new RegExp(attr), `render must emit ${attr}`);
      assert.match(app, new RegExp(`\\[${attr}\\]`), `app must select [${attr}]`);
    }
  });
  it("app marks per-member acted for cluster actions", () => {
    assert.match(app, /:cluster:/, "app must recognize cluster tokens");
  });
  it("app hydrates acted state from /actions and links undos via undoOf", () => {
    assert.match(app, /fetch\("\/actions"\)/, "app must fetch /actions");
    assert.match(app, /undoOf/, "app must send undoOf when undoing");
    assert.match(app, /emailIds\?\.\[0\]/, "app must reconcile server-backed keys (discriminator present)");
  });
  it("app posts the intent-level /senders/delete-all for the cluster delete-all button", () => {
    assert.match(render, /data-delete-sender/, "render must emit data-delete-sender");
    assert.match(app, /\[data-delete-sender\]/, "app must select [data-delete-sender]");
    assert.match(app, /\/senders\/delete-all/, "app must post /senders/delete-all");
  });
  it("app wires the bulk bar to resolveBulkPlan and the endpoints", () => {
    assert.match(app, /resolveBulkPlan/, "app must import/use resolveBulkPlan");
    for (const attr of ["data-bulk-delete", "data-bulk-kill", "data-bulk-delkill", "data-bulk-undo", "data-bulk-clear"]) {
      assert.match(app, new RegExp(`\\[${attr}\\]`), `app must select [${attr}]`);
    }
    assert.match(app, /bulkBusy/, "app must drive the Working state");
    assert.match(app, /failedIds/, "runBulk must respect per-id failures");
  });
});
