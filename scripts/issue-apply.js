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
  const line = `- msgid:${email.id} — ${email.fromName || email.from} ${shortDate(email.receivedAt || email.received)} — ${email.subject || ""}`.trim();
  if (issue.body.includes(`msgid:${email.id}`)) return; // idempotent
  if (/##\s*Linked messages/.test(issue.body)) {
    issue.body = issue.body.replace(/(##\s*Linked messages\s*\n)/, `$1${line}\n`);
  } else {
    issue.body = `${issue.body}\n\n## Linked messages\n${line}\n`;
  }
}

export function applyReasonerOutput(records, emailsById, { issuesDir, now, heuristicMsgids = [] }) {
  const report = { created: [], updated: [], quarantined: [], rescued: [], toTrash: [], noIssue: [] };
  const heuristicSet = new Set(heuristicMsgids);

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
      if (!report.toTrash.includes(rec.msgid)) report.toTrash.push(rec.msgid);
      continue;
    }
    // keep beyond this point
    if (heuristicSet.has(rec.msgid) && !report.rescued.includes(rec.msgid)) {
      report.rescued.push(rec.msgid);
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
    const existing = byId.get(slug);
    if (existing) {
      // Slug already exists (prior run created it) — append, don't overwrite.
      const groupEmails = group.recs.map(r => emailsById[r.msgid]).filter(Boolean);
      for (const e of groupEmails) appendLinkedMessage(existing, e);
      const fwa = group.recs.find(r => r.next_action_update);
      if (fwa) existing.next_action = fwa.next_action_update;
      const fwo = group.recs.find(r => r.waiting_on_update);
      if (fwo) existing.waiting_on = fwo.waiting_on_update;
      existing.last_activity = now;
      saveIssue(existing);
      if (!report.updated.includes(existing.id)) report.updated.push(existing.id);
      continue;
    }
    const emails = group.recs.map(r => emailsById[r.msgid]).filter(Boolean);
    const participants = [...new Set(emails.map(e => `${e.fromName || e.from} <${e.from}>`))];
    const accounts = [...new Set(emails.map(e => e.account).filter(Boolean))];
    const firstWithAction = group.recs.find(r => r.next_action_update);
    const provisional = group.recs.length < 2 && !firstWithAction;
    const aliasCandidates = [slug.split("-")[0]].filter(a => a && a !== slug);
    const existingAliases = new Set([...byId.values()].flatMap(i => (i.aliases || []).map(a => a.toLowerCase())));
    const aliases = aliasCandidates.filter(a => !existingAliases.has(a.toLowerCase()));
    const issue = createIssue(issuesDir, {
      title: group.title,
      aliases,
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

// CLI entrypoint — Windows-safe guard (NOT import.meta.url === file://${argv[1]}).
// Reads JSON from stdin: { records, emailsById, heuristicMsgids?, now }
// Arg 1: issuesDir (default "data/issues"). Prints the report JSON to stdout.
if (process.argv[1] && process.argv[1].endsWith("issue-apply.js")) {
  const issuesDirArg = process.argv[2] || "data/issues";
  let input = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) input += chunk;
  const { records = [], emailsById = {}, heuristicMsgids = [], now } = JSON.parse(input || "{}");
  const report = applyReasonerOutput(records, emailsById, {
    issuesDir: issuesDirArg,
    now: now || new Date().toISOString().slice(0, 10),
    heuristicMsgids,
  });
  process.stdout.write(JSON.stringify(report, null, 2));
}
