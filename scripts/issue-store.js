/**
 * issue-store.js
 *
 * Deterministic CRUD over the issue graph in data/issues/*.md.
 * Real issues live at the top level; provisional singletons live in
 * data/issues/provisional/. No LLM, no judgment — pure file operations.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { atomicWrite } from "./fs-utils.js";

export function slugify(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseIssueFile(content) {
  const normalized = (content || "").replace(/\r\n/g, "\n");
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: normalized.trim() };
  const front = yaml.load(m[1]) || {};
  return { ...front, body: (m[2] || "").trim() };
}

export function serializeIssue(issue) {
  const { body = "", _path, _provisional, ...frontmatter } = issue;
  return `---\n${yaml.dump(frontmatter)}---\n\n${body.trim()}\n`;
}

function readDirIssues(dir, provisional) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const issue = parseIssueFile(readFileSync(path, "utf-8"));
      issue._path = path;
      issue._provisional = provisional;
      out.push(issue);
    } catch (err) {
      // Corrupt file — skip rather than crash the whole load, but leave a trace.
      console.warn(`issue-store: skipping unreadable issue file ${path}: ${err.message}`);
    }
  }
  return out;
}

export function loadIssues(issuesDir) {
  return readDirIssues(issuesDir, false);
}

export function loadProvisional(issuesDir) {
  return readDirIssues(join(issuesDir, "provisional"), true);
}

export function findByAlias(issues, needle) {
  const n = (needle || "").toLowerCase();
  return issues.find(i =>
    (i.id || "").toLowerCase() === n ||
    (i.aliases || []).some(a => (a || "").toLowerCase() === n)
  ) || null;
}

export function listByStatus(issues, status) {
  return issues.filter(i => i.status === status);
}

// ── Write side ────────────────────────────────────────────────────────────────

const DEFAULT_BODY =
  "## Decisions made\n\n## Open questions\n\n## Linked messages\n\n## Log\n";

export function createIssue(issuesDir, fields, { provisional = false, now } = {}) {
  const id = slugify(fields.title);
  const dir = provisional ? join(issuesDir, "provisional") : issuesDir;
  mkdirSync(dir, { recursive: true });
  const issue = {
    id,
    title: fields.title,
    aliases: fields.aliases || [],
    status: "open",
    accounts: fields.accounts || [],
    participants: fields.participants || [],
    opened: now || null,
    last_activity: now || null,
    snooze_until: null,
    next_action: fields.next_action || "",
    waiting_on: fields.waiting_on || "nobody",
    body: fields.body || DEFAULT_BODY,
    _path: join(dir, `${id}.md`),
    _provisional: provisional,
  };
  atomicWrite(issue._path, serializeIssue(issue));
  return issue;
}

export function saveIssue(issue) {
  if (!issue._path) throw new Error(`saveIssue: issue ${issue.id} has no _path`);
  atomicWrite(issue._path, serializeIssue(issue));
  return issue;
}

export function markDone(issue) {
  issue.status = "done";
  return saveIssue(issue);
}

export function snoozeIssue(issue, untilISO) {
  issue.status = "snoozed";
  issue.snooze_until = untilISO;
  return saveIssue(issue);
}

function linkedMsgidLines(body) {
  const m = (body || "").match(/##\s*Linked messages\s*\n([\s\S]*?)(\n##\s|$)/);
  if (!m) return [];
  return m[1].split("\n").map(l => l.trim()).filter(l => l.startsWith("- "));
}

export function mergeIssues(target, source) {
  target.aliases = [...new Set([...(target.aliases || []), ...(source.aliases || []), source.id])];
  target.participants = [...new Set([...(target.participants || []), ...(source.participants || [])])];
  const seen = new Set();
  const keep = [];
  for (const line of [...linkedMsgidLines(target.body), ...linkedMsgidLines(source.body)]) {
    const id = (line.match(/msgid:\S+/) || [line])[0];
    if (seen.has(id)) continue;
    seen.add(id);
    keep.push(line);
  }
  const rebuilt = `## Linked messages\n${keep.join("\n")}`;
  if (/##\s*Linked messages/.test(target.body)) {
    target.body = target.body.replace(/##\s*Linked messages\s*\n[\s\S]*?(?=\n##\s|$)/, rebuilt + "\n");
  } else {
    target.body = `${target.body}\n\n${rebuilt}\n`;
  }
  saveIssue(target);
  rmSync(source._path, { force: true });
  return target;
}

export function graduateProvisional(issuesDir, slug) {
  const from = join(issuesDir, "provisional", `${slug}.md`);
  if (!existsSync(from)) return null;
  const to = join(issuesDir, `${slug}.md`);
  mkdirSync(issuesDir, { recursive: true });
  renameSync(from, to);
  const issue = parseIssueFile(readFileSync(to, "utf-8"));
  issue._path = to;
  issue._provisional = false;
  return issue;
}

export function loadAssignmentState(path) {
  if (!existsSync(path)) return { lastAssignedAt: {} };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { lastAssignedAt: {} };
  }
}

export function saveAssignmentState(path, state) {
  atomicWrite(path, JSON.stringify(state, null, 2));
}
