/**
 * save-gmail-draft.js <accountId>
 *
 * Reads draft data from stdin as JSON: { to, cc, subject, body, threadId? }
 * Creates a Gmail draft and applies the Drafts-OfficeOS label.
 * Returns JSON: { draftId }
 *
 * Usage:
 *   echo '<json>' | node scripts/save-gmail-draft.js <accountId>
 */
import { buildGmailClient } from "./gmail-client.js";

export function buildRfc2822Message({ to, cc, subject, body }) {
  const lines = [
    `To: ${(to || []).join(", ")}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ensureDraftsLabel(gmail) {
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = (res.data.labels || []).find((l) => l.name === "Drafts-OfficeOS");
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: "Drafts-OfficeOS",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return created.data.id;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("save-gmail-draft.js")) {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error("Usage: echo '<json>' | node scripts/save-gmail-draft.js <accountId>");
    process.exit(1);
  }
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", async () => {
    try {
      const draftData = JSON.parse(raw);
      const gmail = await buildGmailClient(accountId);
      const labelId = await ensureDraftsLabel(gmail);

      const messageResource = { raw: buildRfc2822Message(draftData) };
      if (draftData.threadId) messageResource.threadId = draftData.threadId;

      const draft = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: messageResource },
      });
      const draftId = draft.data.id;
      const messageId = draft.data.message.id;

      // Apply Drafts-OfficeOS label to the underlying message
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { addLabelIds: [labelId] },
      });

      console.log(JSON.stringify({ draftId }));
    } catch (err) {
      console.error("Error:", err.message);
      process.exit(1);
    }
  });
}
