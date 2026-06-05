/**
 * collapse.js
 *
 * Pure, deterministic reasoning-unit grouping. NO I/O.
 *
 * Collapses the *reasoning unit*, never the *data*: identical/near-identical
 * emails (exact-dup) and same-sender template batches (alert-batch) are grouped
 * so the reasoner judges a representative once; every member msgid is retained.
 *
 * groupForReasoning(items) -> { groups, byMsgid }
 *   items: [{ msgid, from, fromName, subject, preview, account, tag }]
 *   groups: [{ id, kind: "exact-dup"|"alert-batch"|"single", representativeMsgid, memberMsgids[] }]
 *   byMsgid: { <msgid>: { groupId, isRepresentative } }
 */

const ALERT_BATCH_THRESHOLD = 4;

export function normalizePreview(preview) {
  return (preview || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function subjectSkeleton(subject) {
  return (subject || "")
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "#")
    .replace(/#?\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function fromAddr(item) {
  return (item.from || "").toLowerCase().trim();
}

export function groupForReasoning(items) {
  const groups = [];
  const byMsgid = {};
  let gid = 0;
  const claimed = new Set();

  // 1. exact-dup: identical (from, subject) AND near-identical preview.
  const exactKey = (it) => `${fromAddr(it)} ${(it.subject || "").trim().toLowerCase()} ${normalizePreview(it.preview)}`;
  const exactBuckets = new Map();
  for (const it of items) {
    const k = exactKey(it);
    if (!exactBuckets.has(k)) exactBuckets.set(k, []);
    exactBuckets.get(k).push(it);
  }
  for (const bucket of exactBuckets.values()) {
    if (bucket.length < 2) continue;
    const id = `g${gid++}`;
    const memberMsgids = bucket.map(b => b.msgid);
    groups.push({ id, kind: "exact-dup", representativeMsgid: memberMsgids[0], memberMsgids });
    bucket.forEach((b, i) => { claimed.add(b.msgid); byMsgid[b.msgid] = { groupId: id, isRepresentative: i === 0 }; });
  }

  // 2. alert-batch: >=THRESHOLD same-sender, same subject-skeleton (not already claimed).
  const batchKey = (it) => `${fromAddr(it)} ${subjectSkeleton(it.subject)}`;
  const batchBuckets = new Map();
  for (const it of items) {
    if (claimed.has(it.msgid)) continue;
    const k = batchKey(it);
    if (!batchBuckets.has(k)) batchBuckets.set(k, []);
    batchBuckets.get(k).push(it);
  }
  for (const bucket of batchBuckets.values()) {
    if (bucket.length < ALERT_BATCH_THRESHOLD) continue;
    const id = `g${gid++}`;
    const memberMsgids = bucket.map(b => b.msgid);
    groups.push({ id, kind: "alert-batch", representativeMsgid: memberMsgids[0], memberMsgids });
    bucket.forEach((b, i) => { claimed.add(b.msgid); byMsgid[b.msgid] = { groupId: id, isRepresentative: i === 0 }; });
  }

  // 3. singletons: everything unclaimed is its own representative.
  for (const it of items) {
    if (claimed.has(it.msgid)) continue;
    const id = `g${gid++}`;
    groups.push({ id, kind: "single", representativeMsgid: it.msgid, memberMsgids: [it.msgid] });
    byMsgid[it.msgid] = { groupId: id, isRepresentative: true };
  }

  return { groups, byMsgid };
}
