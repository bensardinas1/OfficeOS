/**
 * seed-demo.js — dev-only: seed a demo world model + queue so the panel can be
 * viewed without live email. Usage: node daemon/seed-demo.js [dataDir]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.argv[2] || join(root, "data");
const store = createStore(dataDir);

const now = new Date().toISOString();
store.saveModel({
  generatedAt: now,
  accounts: { brickell: { status: "ok", lastTickAt: now }, summit: { status: "stale", lastTickAt: now } },
  items: [
    { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell",
      title: "2 failed payments — one root cause", status: "at_risk",
      group: { rootCause: "card_4821", members: [{ vendor: "Acme", from: "billing@acme.com", subject: "Payment failed", emailId: "e1" }, { vendor: "Globex", from: "ar@globex.com", subject: "Declined", emailId: "e2" }] },
      source: [{ kind: "thread", emailId: "e1" }, { kind: "url", url: "https://pay.example/portal" }],
      proposedActions: ["draft_chase", "route:billing_portal"], lastChanged: now },
  ],
});
store.saveQueue({ proposals: [
  { id: "brickell:owed_risk:card_4821::draft_chase", itemId: "brickell:owed_risk:card_4821", action: "draft_chase",
    params: { account: "brickell", drafts: [{}, {}] }, preview: { summary: "2 failed payments — one root cause", drafts: [{}, {}] }, state: "pending" },
] });
process.stdout.write(`seeded demo model at ${dataDir}\n`);
