/**
 * normalizers/index.js — registry mapping a jobType to an adapter with the
 * uniform signature (classified, account, typeConfig, opts) => Item[].
 * Adapters localize each job's input prep so adding a job stays additive.
 */
import { normalizeOwedRisk } from "./owed-risk.js";
import { normalizeHandled } from "./handled.js";
import { regroupStragglers } from "./regroup.js";

function flattenSourceEmails(classified, sourceCategories) {
  const out = [];
  for (const cat of sourceCategories || []) {
    const bucket = classified.categories?.[cat];
    if (bucket?.emails) out.push(...bucket.emails);
  }
  return out;
}

const ADAPTERS = {
  async owed_risk(classified, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.owed_risk;
    const emails = flattenSourceEmails(classified, rules.sourceCategories);
    const items = normalizeOwedRisk(emails, account, rules);
    if (opts?.reasonerFn) return regroupStragglers(items, account, rules, opts.reasonerFn);
    return items;
  },
  handled(classified, account, typeConfig) {
    return normalizeHandled(classified, account, typeConfig);
  },
};

/**
 * Run every job-type the account's typeConfig enables. Unknown jobTypes are skipped.
 * @param opts { reasonerFn? } passed through to adapters that use it (Task 5).
 */
export async function runNormalizers(classified, account, typeConfig, opts = {}) {
  const items = [];
  for (const jobType of Object.keys(typeConfig.jobTypes || {})) {
    const adapter = ADAPTERS[jobType];
    if (!adapter) continue;
    items.push(...await adapter(classified, account, typeConfig, opts));
  }
  return items;
}
