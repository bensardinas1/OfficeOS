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
});
