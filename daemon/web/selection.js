/**
 * selection.js — pure helpers for the workbench's multi-select + bulk action.
 */
export function toggle(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Pending proposal ids belonging to the selected items (item:-prefixed keys). */
export function pendingApprovalsFor(items, selectedIds) {
  return items
    .filter(i => selectedIds.has(`item:${i.id}`))
    .flatMap(i => (i.proposals || []).filter(p => p.state === "pending").map(p => p.id));
}

/**
 * resolveBulkPlan — pure: (action, typed selection, view, acted) -> {ops, skips}.
 * Units: item:<itemId> (tile — precise member ids), cluster:<account>:<sender>
 * (intent-level sender query), conv:<account>:<conversationKey> (precise ids).
 * Tiles/conversations NEVER become sender queries; only clusters do.
 */
export function resolveBulkPlan(action, selectedKeys, view, acted = {}) {
  const ops = [];
  const skips = [];
  const items = (view.groups || []).flatMap(g => g.items || []);
  const itemById = new Map(items.map(i => [i.id, i]));

  // Parse selection into units.
  const units = [];
  for (const k of selectedKeys) {
    if (k.startsWith("item:")) {
      const it = itemById.get(k.slice(5));
      if (it) units.push({ type: "tile", key: k, account: it.account, label: it.title || it.id, members: it.group?.members || [], item: it });
    } else if (k.startsWith("cluster:")) {
      const [, account, ...rest] = k.split(":");
      const sender = rest.join(":");
      const members = items.filter(i => i.account === account && (i.jobType === "handled" || i.jobType === "triage"))
        .flatMap(i => i.group?.members || [])
        .filter(m => (m.from || "").toLowerCase() === sender.toLowerCase());
      units.push({ type: "cluster", key: k, account, sender, label: sender, members });
    } else if (k.startsWith("conv:")) {
      const [, account, ...rest] = k.split(":");
      const convKey = rest.join(":");
      const members = items.filter(i => i.account === account && i.jobType === "handled")
        .flatMap(i => i.group?.members || [])
        .filter(m => m.automated === false && (m.conversationId || `msg:${m.emailId}`) === convKey);
      units.push({ type: "conversation", key: k, account, label: members[0]?.subject || convKey, members });
    }
  }

  const clusterCovered = new Set(); // `${account}|${lowercased sender}` for selected clusters
  for (const u of units) if (u.type === "cluster") clusterCovered.add(`${u.account}|${u.sender.toLowerCase()}`);
  const isCovered = (u, m) => clusterCovered.has(`${u.account}|${(m.from || "").toLowerCase()}`);
  const isDeleted = (m) => !!acted[m.emailId]?.deleted;

  if (action === "approve") {
    for (const u of units) {
      if (u.type !== "tile") continue;
      for (const p of (u.item.proposals || []).filter(p => p.state === "pending")) ops.push({ kind: "approve", proposalId: p.id });
    }
    return { ops, skips };
  }

  const wantDelete = action === "delete" || action === "delkill";
  const wantKill = action === "kill" || action === "delkill";

  if (wantDelete) {
    for (const u of units) {
      if (u.type === "cluster") {
        ops.push({ kind: "deleteBySender", account: u.account, sender: u.sender, optimisticIds: u.members.map(m => m.emailId).filter(Boolean), label: u.label });
        continue;
      }
      const live = u.members.filter(m => m.emailId && !isDeleted(m));
      if (live.length === 0) { skips.push({ label: u.label, reason: "already deleted" }); continue; }
      const ids = live.filter(m => !isCovered(u, m)).map(m => m.emailId);
      if (ids.length === 0) { skips.push({ label: u.label, reason: "covered by selected sender" }); continue; }
      ops.push({ kind: "delete", account: u.account, emailIds: ids, unit: u.type, label: u.label });
    }
  }

  if (wantKill) {
    const bySender = new Map(); // `${account}|${sender}` -> {account, sender, emailIds:Set, label}
    for (const u of units) {
      const senders = [...new Set(u.members.map(m => (m.from || "").toLowerCase()).filter(Boolean))];
      const sender = u.type === "cluster" ? u.sender.toLowerCase() : (senders.length === 1 ? senders[0] : null);
      if (!sender) { skips.push({ label: u.label, reason: senders.length ? "multiple senders" : "no resolvable sender" }); continue; }
      const key = `${u.account}|${sender}`;
      if (!bySender.has(key)) bySender.set(key, { account: u.account, sender, emailIds: new Set(), label: u.label });
      for (const m of u.members) if (m.emailId) bySender.get(key).emailIds.add(m.emailId);
    }
    for (const c of bySender.values()) ops.push({ kind: "kill", account: c.account, sender: c.sender, emailIds: [...c.emailIds], label: c.label });
  }

  if (action === "undo") {
    const restores = new Map();   // deleteEntryId -> {account, emailIds:Set}
    const killRemoves = new Map(); // killEntryId -> {account, sender}
    for (const u of units) {
      let found = 0;
      const entries = u.members.map(m => acted[m.emailId]).filter(Boolean);
      if (u.type === "tile" && acted[u.item?.id]) entries.push(acted[u.item.id]);
      for (const a of entries) {
        if (a.deleted && a.deleteEntryId) {
          if (!restores.has(a.deleteEntryId)) restores.set(a.deleteEntryId, { account: a.account, emailIds: new Set() });
          for (const id of a.emailIds || []) restores.get(a.deleteEntryId).emailIds.add(id);
          found++;
        }
        if (a.killed && a.killEntryId) { killRemoves.set(a.killEntryId, { account: a.account, sender: a.sender }); found++; }
      }
      if (!found) skips.push({ label: u.label, reason: "nothing to undo" });
    }
    for (const [undoOf, r] of restores) ops.push({ kind: "restore", account: r.account, emailIds: [...r.emailIds], undoOf, label: "restore" });
    for (const [undoOf, k] of killRemoves) ops.push({ kind: "killRemove", account: k.account, sender: k.sender, undoOf, label: k.sender });
  }

  return { ops, skips };
}
