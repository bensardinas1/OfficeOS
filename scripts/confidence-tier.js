/**
 * confidence-tier.js
 *
 * Pure, deterministic candidate-lane confidence tier. NO I/O.
 *
 * Gives a corroborated-bulk candidate GROUP its `trash` disposition
 * deterministically — the same verdict the reasoner would emit — so the reasoner
 * need not spend a judgment on it. The silent-loss risk is quarantined here:
 * a group auto-trashes ONLY when TWO independent signals agree (a high structural
 * bulk score AND a collapse group), every member is a candidate (never trash a
 * survivor that collapsed in), and the sender is not protected. This module only
 * stamps verdicts and emits trash records; soft-delete happens downstream.
 *
 * applyConfidenceTier(bundleItems, groups, accountsById)
 *   -> { decisions, tierRecords, stats }
 */

import { isProtectedSender } from "./sender-guards.js";

export function hashMsgid(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

export function isAuditSampled(msgid, auditSamplePercent) {
  if (!auditSamplePercent || auditSamplePercent <= 0) return false;
  if (auditSamplePercent >= 100) return true;
  return hashMsgid(msgid) % 100 < auditSamplePercent;
}

export function applyConfidenceTier(bundleItems, groups, accountsById = {}) {
  const byMsgid = {};
  for (const it of bundleItems || []) byMsgid[it.msgid] = it;

  const decisions = {};
  const tierRecords = [];
  const blankPer = () => ({ eligibleGroups: 0, trashedGroups: 0, auditedGroups: 0, trashedMembers: 0 });
  const stats = { eligibleGroups: 0, trashedGroups: 0, auditedGroups: 0, trashedMembers: 0, perAccount: {} };

  for (const group of groups || []) {
    if (group.kind !== "alert-batch" && group.kind !== "exact-dup") continue;
    const rep = byMsgid[group.representativeMsgid];
    if (!rep) continue;
    const account = accountsById[rep.account];
    const cfg = account && account.candidateTier;
    if (!cfg || (cfg.mode !== "shadow" && cfg.mode !== "active")) continue;

    // All members must be candidates — never trash a survivor that collapsed in.
    const members = group.memberMsgids.map(id => byMsgid[id]);
    if (members.some(m => !m)) continue;
    if (!members.every(m => m.tag === "heuristic-delete-candidate")) continue;

    // Two independent signals: group size AND structural bulk score.
    const size = group.memberMsgids.length;
    if (size < (cfg.minGroupSize ?? 4)) continue;
    const score = rep.bulkScore ?? 0;
    if (score < (cfg.scoreCutoff ?? 3)) continue;

    // Defense-in-depth: never a protected sender.
    if (isProtectedSender(account, (rep.from || "").toLowerCase())) continue;

    stats.eligibleGroups++;
    const per = (stats.perAccount[rep.account] ||= blankPer());
    per.eligibleGroups++;

    const audited = cfg.mode === "active" && isAuditSampled(group.representativeMsgid, cfg.auditSamplePercent);
    decisions[group.representativeMsgid] = { verdict: "trash", score, groupId: group.id, mode: cfg.mode, audited };

    if (cfg.mode === "active" && !audited) {
      stats.trashedGroups++; per.trashedGroups++;
      stats.trashedMembers += size; per.trashedMembers += size;
      const reason = `tier:bulk-score>=${score}+${group.kind}(${size})`;
      for (const id of group.memberMsgids) {
        tierRecords.push({ msgid: id, verdict: "trash", issue: null, reason, next_action_update: "", waiting_on_update: null });
      }
    } else if (cfg.mode === "active" && audited) {
      stats.auditedGroups++; per.auditedGroups++;
    }
  }

  return { decisions, tierRecords, stats };
}
