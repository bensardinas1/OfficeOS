/**
 * normalizers/index.js — registry mapping a jobType to an adapter with the
 * uniform signature (byFolder, account, typeConfig, opts) => Item[].
 * Adapters localize each job's input prep so adding a job stays additive.
 *
 * Multi-folder support: each job may declare `folders: ["inbox", "Security", ...]`
 * (default ["inbox"]). Pass a classifiedByFolder map { folderName: classified }.
 * Back-compat: if a single classified (object with a .categories key) is passed to
 * runNormalizers it is wrapped as { inbox: classified } automatically.
 */
import { normalizeOwedRisk } from "./owed-risk.js";
import { normalizeHandled } from "./handled.js";
import { regroupStragglers } from "./regroup.js";
import { normalizeGateway } from "./gateway.js";
import { normalizeAudit } from "./audit.js";
import { normalizeExposed } from "./exposed.js";
import { prepareEmails } from "./prepare.js";
import { normalizeTriage } from "./triage.js";

function flattenSourceEmails(classified, sourceCategories) {
  const out = [];
  for (const cat of sourceCategories || []) {
    const bucket = classified.categories?.[cat];
    if (bucket?.emails) out.push(...bucket.emails);
  }
  return out;
}

/**
 * Union source-category emails across one or more folders.
 */
function flattenFolders(byFolder, folders, sourceCategories) {
  const out = [];
  for (const f of (folders || ["inbox"])) out.push(...flattenSourceEmails(byFolder[f] || { categories: {} }, sourceCategories));
  return out;
}

/**
 * Merge classified objects from one or more folders into a single classified.
 */
function mergeClassified(byFolder, folders) {
  const categories = {};
  for (const f of (folders || ["inbox"])) {
    const cats = (byFolder[f] || {}).categories || {};
    for (const [id, b] of Object.entries(cats)) { (categories[id] ||= { emails: [] }).emails.push(...(b.emails || [])); }
  }
  return { categories };
}

const ADAPTERS = {
  async owed_risk(byFolder, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.owed_risk;
    const emails = prepareEmails(flattenFolders(byFolder, rules.folders, rules.sourceCategories), { lookbackHours: rules.lookbackHours, nowMs: opts?.nowMs ?? Date.now() });
    const items = normalizeOwedRisk(emails, account, rules);
    if (opts?.reasonerFn) return regroupStragglers(items, account, rules, opts.reasonerFn);
    return items;
  },
  handled(byFolder, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.handled || {};
    const merged = mergeClassified(byFolder, rules.folders);
    return normalizeHandled(merged, account, typeConfig, { lookbackHours: rules.lookbackHours, nowMs: opts?.nowMs ?? Date.now() });
  },
  gateway(byFolder, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.gateway;
    const emails = prepareEmails(flattenFolders(byFolder, rules.folders, rules.sourceCategories), { lookbackHours: rules.lookbackHours, nowMs: opts?.nowMs ?? Date.now() });
    return normalizeGateway(emails, account, rules);
  },
  audit(byFolder, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.audit;
    const emails = prepareEmails(flattenFolders(byFolder, rules.folders, rules.sourceCategories), { lookbackHours: rules.lookbackHours, nowMs: opts?.nowMs ?? Date.now() });
    return normalizeAudit(emails, account, rules);
  },
  exposed(byFolder, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.exposed;
    const emails = prepareEmails(flattenFolders(byFolder, rules.folders, rules.sourceCategories), { lookbackHours: rules.lookbackHours, nowMs: opts?.nowMs ?? Date.now() });
    return normalizeExposed(emails, account, rules);
  },
};

/**
 * Run every job-type the account's typeConfig enables. Unknown jobTypes are skipped.
 *
 * @param arg  classifiedByFolder map { folderName: classified } OR a single classified
 *             (back-compat: single classified with a .categories key is wrapped as { inbox: arg }).
 * @param opts { reasonerFn? } passed through to adapters that use it.
 */
export async function runNormalizers(arg, account, typeConfig, opts = {}) {
  const byFolder = (arg && arg.categories) ? { inbox: arg } : (arg || {});
  const items = [];
  for (const jobType of Object.keys(typeConfig.jobTypes || {})) {
    const adapter = ADAPTERS[jobType];
    if (!adapter) continue;
    items.push(...await adapter(byFolder, account, typeConfig, opts));
  }
  if (opts.pendingDeletions) items.push(...normalizeTriage(opts.pendingDeletions, account, opts));
  return items;
}
