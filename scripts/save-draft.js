/**
 * save-draft.js <accountId>
 *
 * Reads draft data from stdin as JSON: { to, cc, subject, body, replyToMessageId? }
 * Creates a draft in the Drafts-OfficeOS mail folder (created on first use).
 * Returns JSON: { draftId }
 *
 * Usage:
 *   echo '<json>' | node scripts/save-draft.js <accountId>
 */
import { buildGraphClient } from "./graph-client.js";

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildOutlookMessageBody({ to, cc, subject, body }) {
  const htmlBody = body
    .split(/\n\n+/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return {
    subject,
    isDraft: true,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: (to || []).map((addr) => ({ emailAddress: { address: addr } })),
    ccRecipients: (cc || []).map((addr) => ({ emailAddress: { address: addr } })),
  };
}

async function ensureDraftsFolder(client) {
  const folders = await client
    .api("/me/mailFolders")
    .filter("displayName eq 'Drafts-OfficeOS'")
    .get();
  if (folders.value.length > 0) return folders.value[0].id;
  const folder = await client.api("/me/mailFolders").post({ displayName: "Drafts-OfficeOS" });
  return folder.id;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("save-draft.js")) {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error("Usage: echo '<json>' | node scripts/save-draft.js <accountId>");
    process.exit(1);
  }
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", async () => {
    try {
      const draftData = JSON.parse(raw);
      const client = await buildGraphClient(accountId);
      const folderId = await ensureDraftsFolder(client);

      let draftId;
      if (draftData.replyToMessageId) {
        // Create reply draft in native Drafts, patch body, move to Drafts-OfficeOS
        const replyDraft = await client
          .api(`/me/messages/${draftData.replyToMessageId}/createReply`)
          .post({});
        draftId = replyDraft.id;
        const patch = buildOutlookMessageBody(draftData);
        await client.api(`/me/messages/${draftId}`).patch({
          body: patch.body,
          toRecipients: patch.toRecipients,
          ccRecipients: patch.ccRecipients,
        });
        const moved = await client.api(`/me/messages/${draftId}/move`).post({ destinationId: folderId });
        draftId = moved.id;
      } else {
        // Compose: create directly in Drafts-OfficeOS
        const msg = await client
          .api(`/me/mailFolders/${folderId}/messages`)
          .post(buildOutlookMessageBody(draftData));
        draftId = msg.id;
      }
      console.log(JSON.stringify({ draftId }));
    } catch (err) {
      console.error("Error:", err.message);
      process.exit(1);
    }
  });
}
