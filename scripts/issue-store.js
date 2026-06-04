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
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: content.trim() };
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
    } catch {
      // Corrupt file — skip rather than crash the whole load.
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
