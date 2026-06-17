/**
 * selection.js — pure helpers for the workbench's multi-select + bulk action.
 */
export function toggle(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Pending proposal ids belonging to the selected items. */
export function pendingApprovalsFor(items, selectedIds) {
  return items
    .filter(i => selectedIds.has(i.id))
    .flatMap(i => (i.proposals || []).filter(p => p.state === "pending").map(p => p.id));
}
