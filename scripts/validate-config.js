/**
 * validate-config.js — pure structural validation of companies.json +
 * account-types.json. Warn-and-continue by contract: NEVER throws; worst case
 * it returns findings. error = the rule/account is structurally unusable
 * (runtime will skip or misread it); warning = functional but suspicious.
 */
const KNOWN_RULE_TYPES = new Set(["email", "domain", "name", "keyword"]);
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateConfig(companies, accountTypes) {
  const findings = [];
  const err = (path, message) => findings.push({ level: "error", path, message });
  const warn = (path, message) => findings.push({ level: "warning", path, message });

  const accounts = Array.isArray(companies?.companies) ? companies.companies : null;
  if (!accounts) {
    err("companies", "companies.json must contain a companies array");
    return findings;
  }

  const checkRules = (list, path) => {
    if (list == null) return;
    if (!Array.isArray(list)) { err(path, "must be an array of sender rules"); return; }
    list.forEach((r, j) => {
      if (!r || typeof r !== "object") { err(`${path}[${j}]`, "rule is not an object"); return; }
      if (!KNOWN_RULE_TYPES.has(r.type)) err(`${path}[${j}].type`, `unknown sender rule type ${JSON.stringify(r.type ?? null)} (known: email, domain, name, keyword)`);
      if (typeof r.value !== "string" || !r.value.trim()) err(`${path}[${j}].value`, "missing or empty rule value");
    });
  };
  const checkFlags = (flags, path) => {
    if (flags == null) return;
    if (!Array.isArray(flags)) { err(path, "must be an array of strings"); return; }
    flags.forEach((f, j) => {
      if (typeof f !== "string" || !f.trim()) err(`${path}[${j}]`, "flags must be non-empty strings");
    });
  };

  const seenIds = new Set();
  accounts.forEach((a, i) => {
    const label = (a && typeof a === "object" && typeof a.id === "string" && a.id) ? a.id : `#${i}`;
    const p = (s) => `companies[${label}]${s}`;
    if (!a || typeof a !== "object") { err(`companies[${label}]`, "account entry is not an object"); return; }

    if (typeof a.id !== "string" || !a.id.trim()) err(p(".id"), "missing or empty account id");
    else if (seenIds.has(a.id)) warn(p(".id"), `duplicate account id "${a.id}"`);
    else seenIds.add(a.id);

    if (a.provider !== "outlook" && a.provider !== "gmail") err(p(".provider"), `provider must be "outlook" or "gmail" (got ${JSON.stringify(a.provider ?? null)})`);
    if (a.accountType != null && !(accountTypes && typeof accountTypes === "object" && Object.hasOwn(accountTypes, a.accountType))) {
      err(p(".accountType"), `references unknown account type "${a.accountType}"`);
    }
    if (a.myEmail == null) warn(p(".myEmail"), "myEmail missing — own-mail exclusion and the urgency standing gate are degraded");
    else if (typeof a.myEmail !== "string" || !EMAIL_SHAPE.test(a.myEmail)) err(p(".myEmail"), "myEmail is not shaped like an email address");

    checkRules(a.prioritySenders, p(".prioritySenders"));
    checkRules(a.neverDelete, p(".neverDelete"));
    checkRules(a.alwaysDelete, p(".alwaysDelete"));
    checkFlags(a.urgencyRules?.flags, p(".urgencyRules.flags"));

    (Array.isArray(a.categoryOverrides) ? a.categoryOverrides : []).forEach((cat, j) => {
      if (!cat || typeof cat !== "object") return;
      checkRules(cat.prioritySenders, p(`.categoryOverrides[${j}].prioritySenders`));
      checkFlags(cat.urgencyRules?.flags, p(`.categoryOverrides[${j}].urgencyRules.flags`));
    });

    if (a.bulkSignalThreshold != null && !(typeof a.bulkSignalThreshold === "number" && a.bulkSignalThreshold > 0)) {
      warn(p(".bulkSignalThreshold"), "bulkSignalThreshold should be a positive number");
    }

    const norm = (r) => `${r?.type}:${String(r?.value ?? "").toLowerCase()}`;
    const never = new Set((Array.isArray(a.neverDelete) ? a.neverDelete : []).map(norm));
    (Array.isArray(a.alwaysDelete) ? a.alwaysDelete : []).forEach((r, j) => {
      if (r && never.has(norm(r))) warn(p(`.alwaysDelete[${j}]`), `"${r.value}" is also in neverDelete — contradictory; neverDelete wins at runtime`);
    });
  });

  return findings;
}
