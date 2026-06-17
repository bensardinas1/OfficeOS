import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripHtml } from "../fetch-emails.js";

describe("stripHtml", () => {
  it("strips tags and decodes entities", () => {
    assert.equal(stripHtml("<p>Hello&nbsp;<b>world</b> &amp; more</p>").trim(), "Hello world & more");
  });
  it("drops style/script blocks", () => {
    const out = stripHtml("<style>.x{color:red}</style><script>alert(1)</script><div>Visible</div>");
    assert.match(out, /Visible/);
    assert.doesNotMatch(out, /color:red|alert/);
  });
  it("collapses whitespace and handles empty", () => {
    assert.equal(stripHtml("a\n\n   b\t c"), "a b c");
    assert.equal(stripHtml(""), "");
    assert.equal(stripHtml(null), "");
  });
});
