/**
 * issue-apply.js
 *
 * Deterministic applier: turns reasoner-output records + the email bundle into
 * issue-store mutations and a soft-delete list. No LLM, no network. The skill
 * performs the actual soft-deletes on the returned toTrash msgids.
 *
 * Record: { msgid, verdict: "keep"|"trash", issue: "<id>"|"NEW:Title"|null,
 *           reason, next_action_update, waiting_on_update }
 */

import {
  slugify, loadIssues, loadProvisional, findByAlias, createIssue, saveIssue,
} from "./issue-store.js";

function shortDate(iso) {
  const m = (iso || "").match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${Number(m[1])}/${Number(m[2])}`;
}

function appendLinkedMessage(issue, email) {
  const line = `- msgid:${email.id} — ${email.fromName || email.from} ${shortDate(email.received)} — ${email.subject || ""}`.trim();
  if (issue.body.includes(`msgid:${email.id}`)) return; // idempotent
  if (/##\s*Linked messages/.test(issue.body)) {
    issue.body = issue.body.replace(/(##\s*Linked messages\s*\n)/, `$1${line}\n`);
  } else {
    issue.body = `${issue.body}\n\n## Linked messages\n${line}\n`;
  }
}

export function applyReasonerOutput(records, emailsById, { issuesDir, now }) {
  const report = { created: [], updated: [], quarantined: [], rescued: [], toTrash: [], noIssue: [] };

  const realIssues = loadIssues(issuesDir);
  const provIssues = loadProvisional(issuesDir);
  const byId = new Map([...realIssues, ...provIssues].map(i => [i.id, i]));

  // First pass: group "NEW:" targets by slug so multiple emails → one issue.
  const newGroups = new Map(); // slug → { title, recs: [] }
  for (const rec of records) {
    if (rec.verdict === "trash") continue;
    if (typeof rec.issue === "string" && rec.issue.startsWith("NEW:")) {
      const title = rec.issue.slice(4).trim();
      const slug = slugify(title);
      if (!newGroups.has(slug)) newGroups.set(slug, { title, recs: [] });
      newGroups.get(slug).recs.push(rec);
    }
  }

  // Apply trash + existing-issue assignments + null-keeps.
  for (const rec of records) {
    const email = emailsById[rec.msgid];
    if (rec.verdict === "trash") {
      report.toTrash.push(rec.msgid);
      continue;
    }
    if (rec.issue == null) { report.noIssue.push(rec.msgid); continue; }
    if (rec.issue.startsWith("NEW:")) continue; // handled below
    const issue = byId.get(rec.issue) || findByAlias([...byId.values()], rec.issue);
    if (!issue) { report.noIssue.push(rec.msgid); continue; }
    if (email) appendLinkedMessage(issue, email);
    if (rec.next_action_update) issue.next_action = rec.next_action_update;
    if (rec.waiting_on_update) issue.waiting_on = rec.waiting_on_update;
    issue.last_activity = now;
    saveIssue(issue);
    if (!report.updated.includes(issue.id)) report.updated.push(issue.id);
  }

  // Create the grouped NEW issues.
  for (const [slug, group] of newGroups) {
    const emails = group.recs.map(r => emailsById[r.msgid]).filter(Boolean);
    const participants = [...new Set(emails.map(e => `${e.fromName || e.from} <${e.from}>`))];
    const accounts = [...new Set(emails.map(e => e.account).filter(Boolean))];
    const firstWithAction = group.recs.find(r => r.next_action_update);
    const provisional = emails.length < 2 && !firstWithAction;
    const issue = createIssue(issuesDir, {
      title: group.title,
      aliases: [slug.split("-")[0]].filter(a => a && a !== slug),
      accounts,
      participants,
      next_action: firstWithAction ? firstWithAction.next_action_update : "",
      waiting_on: (group.recs.find(r => r.waiting_on_update) || {}).waiting_on_update || "you",
    }, { provisional, now });
    for (const e of emails) appendLinkedMessage(issue, e);
    saveIssue(issue);
    if (provisional) report.quarantined.push(issue.id);
    else report.created.push(issue.id);
  }

  return report;
}
