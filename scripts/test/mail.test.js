import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchMail, stripHtml, _setClientFactoryForTest } from "../mail.js";

const outlookAcct = { id: "brickell", provider: "outlook", myEmail: "me@brickell.com" };
const gmailAcct = { id: "personal", provider: "gmail" };

afterEach(() => _setClientFactoryForTest(null));

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

describe("stripHtml", () => {
  it("strips tags/styles and collapses whitespace", () => {
    assert.equal(stripHtml("<style>x{}</style><p>a  <b>b</b></p>"), "a b");
  });
});
