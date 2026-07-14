import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchMail, stripHtml, _setClientFactoryForTest } from "../mail.js";

const outlookAcct = { id: "brickell", provider: "outlook", myEmail: "me@brickell.com" };
const gmailAcct = { id: "personal", provider: "gmail" };

const ORIGINAL_BRICKELL_EMAIL = process.env.BRICKELL_EMAIL;

afterEach(() => {
  _setClientFactoryForTest(null);
  if (ORIGINAL_BRICKELL_EMAIL === undefined) delete process.env.BRICKELL_EMAIL;
  else process.env.BRICKELL_EMAIL = ORIGINAL_BRICKELL_EMAIL;
});

/** Fake Graph client: .api(url).filter().select().orderby().top().get() with paging. */
function fakeGraph(pages) {
  let call = 0;
  const chain = (state) => ({
    filter: (f) => { state.filter = f; return chain(state); },
    select: (s) => { state.select = s; return chain(state); },
    orderby: (o) => { state.orderby = o; return chain(state); },
    top: (t) => { state.top = t; return chain(state); },
    post: async (body) => { state.posted = body; return {}; },
    get: async () => pages[call++] ?? { value: [] },
  });
  const client = { api: (url) => { client.urls.push(url); return chain(client.state = {}); }, urls: [], state: {} };
  return client;
}

function graphMsg(i) {
  return { id: `m${i}`, subject: `s${i}`, from: { emailAddress: { address: `a${i}@x.com`, name: `A${i}` } },
    receivedDateTime: `2026-07-0${(i % 9) + 1}T00:00:00Z`, isRead: false, importance: "normal",
    hasAttachments: false, bodyPreview: "p".repeat(400),
    internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:u@x.com>" }, { name: "To", value: "me@brickell.com" }] };
}

describe("fetchMail — outlook", () => {
  it("paginates @odata.nextLink up to max and maps the unified shape", async () => {
    process.env.BRICKELL_EMAIL = "me@brickell.com";
    const pages = [
      { value: [graphMsg(1), graphMsg(2)], "@odata.nextLink": "https://graph/next1" },
      { value: [graphMsg(3), graphMsg(4)] },
    ];
    const client = fakeGraph(pages);
    _setClientFactoryForTest(async () => client);
    const emails = await fetchMail(outlookAcct, { hours: 24, max: 3 });
    assert.equal(emails.length, 3);
    assert.equal(emails[0].id, "m1");
    assert.equal(emails[0].from, "a1@x.com");
    assert.equal(emails[0].hasListUnsubscribe, true);
    assert.equal(emails[0].toRecipients, "me@brickell.com");
    assert.deepEqual(emails[0].gmailCategories, []);
    assert.equal(emails[0].preview.length, 300); // preview trimmed
    assert.match(client.urls[0], /mailFolders\/inbox\/messages/);
    assert.match(client.urls[1], /graph\/next1/); // followed nextLink
  });

  it("includes stripped body when bodyChars > 0", async () => {
    process.env.BRICKELL_EMAIL = "me@brickell.com";
    const msg = { ...graphMsg(1), body: { content: "<p>Hello <b>world</b></p>" } };
    _setClientFactoryForTest(async () => fakeGraph([{ value: [msg] }]));
    const [e] = await fetchMail(outlookAcct, { bodyChars: 5 });
    assert.equal(e.body, "Hello");
  });
});

/** Fake Gmail client with list pagination + metadata get. */
function fakeGmail(idPages, metaFor) {
  let page = 0;
  return { users: { messages: {
    list: async ({ pageToken }) => {
      const p = idPages[page++] || { messages: [] };
      return { data: { messages: p.messages, nextPageToken: p.nextPageToken } };
    },
    get: async ({ id }) => ({ data: metaFor(id) }),
    trash: async () => ({}), untrash: async () => ({}),
  } } };
}

function gmailMeta(id) {
  return { id, threadId: `t-${id}`, internalDate: String(Date.now()), snippet: "hi",
    payload: { headers: [
      { name: "From", value: `Sender <s@x.com>` }, { name: "Subject", value: `sub-${id}` },
      { name: "Date", value: new Date().toUTCString() },
    ] }, labelIds: ["INBOX"] };
}

describe("fetchMail — gmail", () => {
  it("paginates past 100 via nextPageToken up to max", async () => {
    const idPages = [
      { messages: Array.from({ length: 100 }, (_, i) => ({ id: `g${i}` })), nextPageToken: "tok" },
      { messages: Array.from({ length: 50 }, (_, i) => ({ id: `g${100 + i}` })) },
    ];
    _setClientFactoryForTest(async () => fakeGmail(idPages, gmailMeta));
    const emails = await fetchMail(gmailAcct, { hours: 24, max: 120 });
    assert.equal(emails.length, 120); // crossed the old 100 cap
    assert.ok(emails.every(e => e.id && e.subject));
  });
});

describe("getClient — cache eviction on rejected build", () => {
  it("evicts a rejected client build so the next call can succeed", async () => {
    let calls = 0;
    _setClientFactoryForTest(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return fakeGmail([{ messages: [{ id: "g1" }] }], gmailMeta);
    });
    await assert.rejects(() => fetchMail(gmailAcct, { hours: 24, max: 10 }), /boom/);
    const emails = await fetchMail(gmailAcct, { hours: 24, max: 10 });
    assert.equal(calls, 2); // cache was evicted, factory retried
    assert.equal(emails.length, 1);
    assert.equal(emails[0].id, "g1");
  });
});

describe("stripHtml", () => {
  it("strips tags/styles and collapses whitespace", () => {
    assert.equal(stripHtml("<style>x{}</style><p>a  <b>b</b></p>"), "a b");
  });
});

import { deleteEmails, restoreEmails, fetchMessageBody } from "../mail.js";

describe("deleteEmails / restoreEmails", () => {
  it("outlook: per-id move to deleteditems, collecting failed ids", async () => {
    const calls = [];
    const client = { api: (url) => ({ post: async (b) => {
      calls.push({ url, b });
      if (url.includes("bad")) throw new Error("boom");
      return {};
    }, select: () => ({ get: async () => ({}) }) }) };
    _setClientFactoryForTest(async () => client);
    const r = await deleteEmails(outlookAcct, ["ok1", "bad2", "ok3"]);
    assert.deepEqual(r, { trashed: 2, failed: 1, failedIds: ["bad2"] });
    assert.equal(calls[0].b.destinationId, "deleteditems");
  });

  it("gmail: trash / untrash per id", async () => {
    const trashed = [], untrashed = [];
    _setClientFactoryForTest(async () => ({ users: { messages: {
      trash: async ({ id }) => { if (id === "x") throw new Error("no"); trashed.push(id); },
      untrash: async ({ id }) => { untrashed.push(id); },
    } } }));
    const d = await deleteEmails(gmailAcct, ["a", "x"]);
    assert.deepEqual(d, { trashed: 1, failed: 1, failedIds: ["x"] });
    const u = await restoreEmails(gmailAcct, ["a"]);
    assert.deepEqual(u, { restored: 1, failed: 0, failedIds: [] });
  });

  it("outlook restore moves back to inbox", async () => {
    let posted;
    _setClientFactoryForTest(async () => ({ api: () => ({ post: async (b) => { posted = b; return {}; } }) }));
    const r = await restoreEmails(outlookAcct, ["m1"]);
    assert.equal(r.restored, 1);
    assert.equal(posted.destinationId, "inbox");
  });
});

describe("fetchMessageBody", () => {
  it("outlook: strips html body", async () => {
    process.env.BRICKELL_EMAIL = "me@brickell.com";
    _setClientFactoryForTest(async () => ({ api: () => ({ select: () => ({ get: async () => ({ id: "m1", body: { content: "<p>hi</p>" } }) }) }) }));
    assert.deepEqual(await fetchMessageBody(outlookAcct, "m1"), { id: "m1", body: "hi" });
  });
  it("gmail: extracts from payload", async () => {
    const data = { id: "g1", payload: { mimeType: "text/plain", body: { data: Buffer.from("yo").toString("base64") } } };
    _setClientFactoryForTest(async () => ({ users: { messages: { get: async () => ({ data }) } } }));
    assert.deepEqual(await fetchMessageBody(gmailAcct, "g1"), { id: "g1", body: "yo" });
  });
});
