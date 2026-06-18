import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";

let server, base, dir, webDir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "officeos-web-"));
  webDir = join(dir, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Panel</title><div id=app></div>");
  writeFileSync(join(webDir, "app.js"), "export const x = 1;");
  writeFileSync(join(webDir, "styles.css"), "body{color:red}");
  writeFileSync(join(webDir, "blob.xyz"), "raw");
  const sibling = join(dir, "web-secret");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "leak.txt"), "SECRET");
  const store = createStore(dir);
  store.saveModel({ generatedAt: "t", accounts: {}, items: [] });
  store.saveQueue({ proposals: [] });
  server = createApiServer({ store, ctxFor: () => ({}), getLastTickAt: () => "t", webDir });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe("static serving", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /id=app/);
  });
  it("serves a js asset with the right content-type", async () => {
    const res = await fetch(`${base}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
  });
  it("does not serve the /model API as a static file (API still wins)", async () => {
    const res = await fetch(`${base}/model`);
    assert.match(res.headers.get("content-type"), /application\/json/);
  });
  it("blocks path traversal", async () => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.equal(res.status, 404);
  });
  it("blocks a sibling directory that shares the web dir name prefix", async () => {
    const res = await fetch(`${base}/..%2fweb-secret%2fleak.txt`);
    assert.equal(res.status, 404);
  });
  it("serves css as text/css", async () => {
    const res = await fetch(`${base}/styles.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/css/);
  });
  it("serves an unknown extension as application/octet-stream", async () => {
    const res = await fetch(`${base}/blob.xyz`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/octet-stream/);
  });
});
