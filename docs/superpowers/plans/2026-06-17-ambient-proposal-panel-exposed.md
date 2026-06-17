# Ambient Proposal Panel — `exposed` job (security findings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `exposed` job-type — security findings — as a registry normalizer with four config-driven recognizers (Defender for Cloud attack paths, Defender for Endpoint CVEs, BrickellPay PCI tamper, Entra ID Protection digests), deduped by stable IDs, severity→status, **link-out only (never fabricate)**, noise suppressed, and acknowledgeable.

**Architecture:** Four pure **recognizers** (`daemon/normalizers/exposed/{defender-cloud,defender-endpoint,pci-tamper,entra}.js`), each `(email, cfg) => Finding | null`. `daemon/normalizers/exposed.js` runs every configured recognizer over the candidate emails, dedupes findings by `identityKey`, maps severity→status, emits one Item per finding (`acknowledgeable: true`). Registered in the existing registry; scheduler/panel/store/api/acknowledge all reused unchanged.

**Tech Stack:** Node.js ESM, `node --test` + `node:assert/strict`. No new dependencies. Builds on Plans 1–6. Fixtures derive from the real security `.msg` samples (no secrets committed).

---

## Scope

**In this plan:** the `exposed` job — four recognizers, the normalizer, registry wiring, config, docs. Reuses panel rendering (route link from `source[0]`), acknowledge (sets `acknowledgeable: true`), and the scheduler fingerprint/ack flow (Plan 6).

**Not in this plan:** a per-source "all clear" summary line (deferred); deep parsing of full email bodies beyond the preview snippet (recognizers degrade gracefully when an ID isn't in the preview); the gateway-bug `IR-…` intake (test data, deferred).

## Prerequisites / starting state

Plans 1–6 merged. Registry `daemon/normalizers/index.js` has `ADAPTERS` (`owed_risk`, `handled`, `gateway`, `audit`) + `flattenSourceEmails` + async `runNormalizers`. Items are stamped with `fingerprint` and run through `applyAcks` by the scheduler; the panel shows an Acknowledge button for `acknowledgeable` items. Canonical Item shape. Email objects: `{id, from, fromName, subject, preview, receivedAt}`.

Real sample senders (scraped from the `.msg` files): Defender for Cloud = `MSSecurity-noreply@microsoft.com`; Defender for Endpoint = `defender-noreply@microsoft.com`; PCI tamper = `noreply@brickellpay.com` (subject "[PCI] Tamper Detection alert"); Entra = `azure-noreply@microsoft.com`. Real identifiers: attack-path IDs (`7a226bfd-a239-…`), CVEs (`CVE-2026-48778`, CVSS 7.8, Notepad++), PCI severity `HIGH` + type `CONTENT_MODIFICATION` + a URL, Entra digest counts (the sample is **0** risky users/sign-ins → suppress).

**Noise decision applied here:** Entra digests with 0 counts → recognizer returns `null` (suppressed). PCI alerts surface even from the `sandbox.` host (that is the user's monitored environment — do NOT suppress sandbox for PCI).

---

### Task 1: Config — declare the `exposed` job + 4 recognizers

**Files:**
- Modify: `config/account-types.example.json`
- Modify: `daemon/config.test.js`

- [ ] **Step 1: Add the failing test** — append inside the existing describe block in `daemon/config.test.js`:

```js
  it("business declares an exposed job with four security recognizers", () => {
    const cfg = JSON.parse(readFileSync(join(root, "config/account-types.example.json"), "utf-8"));
    const e = cfg.business.jobTypes?.exposed;
    assert.ok(e, "business.jobTypes.exposed must exist");
    assert.ok(Array.isArray(e.sourceCategories) && e.sourceCategories.length > 0);
    for (const k of ["defenderCloud", "defenderEndpoint", "pciTamper", "entra"]) {
      assert.ok(e.recognizers?.[k], `recognizer ${k} must exist`);
    }
    assert.ok(Array.isArray(e.atRiskSeverities) && e.atRiskSeverities.includes("High"));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/config.test.js`
Expected: FAIL — `business.jobTypes.exposed must exist`.

- [ ] **Step 3: Edit `config/account-types.example.json`** — add an `exposed` sibling in `business.jobTypes` (after `audit`, add a comma):

```json
      "exposed": {
        "sourceCategories": ["action", "fyi"],
        "atRiskSeverities": ["Critical", "High"],
        "recognizers": {
          "defenderCloud": {
            "senderDomains": ["microsoft.com"],
            "senderHints": ["mssecurity-noreply"],
            "subjectMarkers": ["attack path"],
            "portalUrl": "https://portal.azure.com"
          },
          "defenderEndpoint": {
            "senderDomains": ["microsoft.com"],
            "senderHints": ["defender-noreply"],
            "subjectMarkers": ["vulnerabilit"],
            "portalUrl": "https://security.microsoft.com"
          },
          "pciTamper": {
            "senderDomains": ["brickellpay.com"],
            "subjectMarkers": ["tamper detection"],
            "portalUrl": "https://sandbox.payments.brickellpay.com/admin/pci/dashboard"
          },
          "entra": {
            "senderDomains": ["microsoft.com"],
            "senderHints": ["azure-noreply"],
            "subjectMarkers": ["entra id protection", "identity protection"]
          }
        }
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/config.test.js`
Expected: PASS. Then `npm test` → no JSON regression.

- [ ] **Step 5: Commit**

```bash
git add config/account-types.example.json daemon/config.test.js
git commit -m "chore(daemon): declare the exposed job + 4 security recognizers"
```

(Operator note: add the same `jobTypes.exposed` block to the live `config/account-types.json`.)

---

### Task 2: Defender for Cloud recognizer (pure)

**Files:**
- Create: `daemon/normalizers/exposed/defender-cloud.js`
- Create: `daemon/normalizers/exposed/defender-cloud.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/exposed/defender-cloud.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeDefenderCloud } from "./defender-cloud.js";

const cfg = { senderDomains: ["microsoft.com"], senderHints: ["mssecurity-noreply"], subjectMarkers: ["attack path"], portalUrl: "https://portal.azure.com" };

describe("recognizeDefenderCloud", () => {
  it("recognizes an attack-path finding with severity and a stable id", () => {
    const f = recognizeDefenderCloud({
      from: "MSSecurity-noreply@microsoft.com",
      subject: "Microsoft Defender for Cloud found potential attack path in your environment",
      preview: "Internet exposed Azure VM with high severity vulnerabilities allows lateral movement. Risk level: Critical. Attack path ID 7a226bfd-a239-5699-a4dc-0aba63478b99",
    }, cfg);
    assert.equal(f.source, "defender_cloud");
    assert.equal(f.severity, "Critical");
    assert.equal(f.identityKey, "attackpath:7a226bfd-a239-5699-a4dc-0aba63478b99");
    assert.equal(f.url, "https://portal.azure.com");
    assert.match(f.title, /attack path/i);
  });

  it("returns null for a non-Defender-Cloud email", () => {
    assert.equal(recognizeDefenderCloud({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/exposed/defender-cloud.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `daemon/normalizers/exposed/defender-cloud.js`**

```js
/**
 * exposed/defender-cloud.js — pure recognizer for Microsoft Defender for Cloud
 * "attack path" emails. Dedupe by attack-path ID; link out to the Azure portal
 * (the exact resource names live there — never reconstructed here).
 */
import { senderMatches, severityFrom, shortHash } from "./util.js";

export function recognizeDefenderCloud(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const idm = text.match(/Attack path ID\s*([a-f0-9-]{8,})/i);
  const id = idm ? idm[1] : shortHash(text);
  const severity = severityFrom(text) || "High";
  return {
    source: "defender_cloud",
    identityKey: `attackpath:${id}`,
    severity,
    title: `${severity} · Attack path`,
    url: cfg.portalUrl,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/exposed/defender-cloud.test.js`
Expected: FAIL — cannot find module `./util.js` (created in Task 3's shared step). Create `util.js` now (it is shared by all recognizers):

Create `daemon/normalizers/exposed/util.js`:

```js
/**
 * exposed/util.js — shared pure helpers for the security recognizers.
 */
import { createHash } from "node:crypto";

export function senderMatches(email, cfg) {
  const f = (email.from || "").toLowerCase();
  const domainOk = (cfg.senderDomains || []).some(d => f.endsWith("@" + d.toLowerCase()) || f.endsWith("." + d.toLowerCase()));
  if (!domainOk) return false;
  if (!cfg.senderHints || cfg.senderHints.length === 0) return true;
  return cfg.senderHints.some(h => f.includes(h.toLowerCase()));
}

export function severityFrom(text) {
  const m = text.match(/\b(Critical|High|Medium|Low)\b/i);
  if (!m) return null;
  const s = m[1].toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function shortHash(s) {
  return createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}
```

Re-run: `node --test daemon/normalizers/exposed/defender-cloud.test.js`
Expected: PASS (2 tests).

NOTE: `util.js` imports `node:crypto`, so recognizers are node-side (they run in the daemon, never the browser) — that's fine; only `daemon/web/*` must stay browser-safe.

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/exposed/util.js daemon/normalizers/exposed/defender-cloud.js daemon/normalizers/exposed/defender-cloud.test.js
git commit -m "feat(daemon): Defender for Cloud recognizer + exposed util (pure)"
```

---

### Task 3: Defender for Endpoint (CVE) recognizer (pure)

**Files:**
- Create: `daemon/normalizers/exposed/defender-endpoint.js`
- Create: `daemon/normalizers/exposed/defender-endpoint.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/exposed/defender-endpoint.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeDefenderEndpoint } from "./defender-endpoint.js";

const cfg = { senderDomains: ["microsoft.com"], senderHints: ["defender-noreply"], subjectMarkers: ["vulnerabilit"], portalUrl: "https://security.microsoft.com" };

describe("recognizeDefenderEndpoint", () => {
  it("recognizes a CVE finding deduped by CVE id", () => {
    const f = recognizeDefenderEndpoint({
      from: "defender-noreply@microsoft.com",
      subject: "New vulnerabilities notification from Microsoft Defender for Endpoint",
      preview: "Vulnerability Name CVE-2026-48778 Severity High CVSS 7.8 Affected products Notepad++",
    }, cfg);
    assert.equal(f.source, "defender_endpoint");
    assert.equal(f.severity, "High");
    assert.equal(f.identityKey, "cve:CVE-2026-48778");
    assert.match(f.title, /CVE-2026-48778/);
    assert.equal(f.url, "https://security.microsoft.com");
  });

  it("returns null for a non-Defender-Endpoint email", () => {
    assert.equal(recognizeDefenderEndpoint({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/exposed/defender-endpoint.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `daemon/normalizers/exposed/defender-endpoint.js`**

```js
/**
 * exposed/defender-endpoint.js — pure recognizer for Microsoft Defender for
 * Endpoint vulnerability notifications. Dedupe by CVE; link to the Defender
 * portal for the full recommendation/affected-device list.
 */
import { senderMatches, severityFrom, shortHash } from "./util.js";

export function recognizeDefenderEndpoint(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const cve = text.match(/CVE-\d{4}-\d+/i);
  const id = cve ? cve[0].toUpperCase() : shortHash(text);
  const severity = severityFrom((text.match(/Severity\s+\w+/i) || [""])[0]) || severityFrom(text) || "High";
  return {
    source: "defender_endpoint",
    identityKey: `cve:${id}`,
    severity,
    title: `${severity} · ${cve ? cve[0].toUpperCase() : "Vulnerability"}`,
    url: cfg.portalUrl,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/exposed/defender-endpoint.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/exposed/defender-endpoint.js daemon/normalizers/exposed/defender-endpoint.test.js
git commit -m "feat(daemon): Defender for Endpoint (CVE) recognizer (pure)"
```

---

### Task 4: PCI tamper recognizer (pure)

**Files:**
- Create: `daemon/normalizers/exposed/pci-tamper.js`
- Create: `daemon/normalizers/exposed/pci-tamper.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/exposed/pci-tamper.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizePciTamper } from "./pci-tamper.js";

const cfg = { senderDomains: ["brickellpay.com"], subjectMarkers: ["tamper detection"], portalUrl: "https://sandbox.payments.brickellpay.com/admin/pci/dashboard" };

describe("recognizePciTamper", () => {
  it("recognizes a PCI tamper alert with severity, type, and a deduped id", () => {
    const f = recognizePciTamper({
      from: "noreply@brickellpay.com",
      subject: "[PCI] Tamper Detection alert - HIGH",
      preview: "PCI Tamper Detection Alert SEVERITY HIGH TYPE CONTENT_MODIFICATION URL https://sandbox.payments.brickellpay.com/admin/pci/dashboard",
    }, cfg);
    assert.equal(f.source, "pci_tamper");
    assert.equal(f.severity, "High");
    assert.match(f.identityKey, /^pci:/);
    assert.match(f.title, /tamper/i);
    assert.ok(/brickellpay\.com/.test(f.url));
  });

  it("returns null when sender or subject doesn't match", () => {
    assert.equal(recognizePciTamper({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/exposed/pci-tamper.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `daemon/normalizers/exposed/pci-tamper.js`**

```js
/**
 * exposed/pci-tamper.js — pure recognizer for BrickellPay PCI tamper alerts.
 * Dedupe by change-type + affected URL. Surfaces even from the sandbox host
 * (that is the monitored environment). Links to the PCI dashboard.
 */
import { senderMatches, shortHash } from "./util.js";

export function recognizePciTamper(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const sevm = text.match(/SEVERITY\s*[:\s]\s*(HIGH|CRITICAL|MEDIUM|LOW)/i) || text.match(/-\s*(HIGH|CRITICAL|MEDIUM|LOW)\b/i);
  const sevRaw = sevm ? sevm[1] : "HIGH";
  const severity = sevRaw.charAt(0).toUpperCase() + sevRaw.slice(1).toLowerCase();
  const typem = text.match(/TYPE\s*[:\s]\s*([A-Z_]{4,})/);
  const type = typem ? typem[1] : "TAMPER";
  const urlm = text.match(/URL\s*[:\s]\s*(https?:\/\/\S+)/i) || text.match(/https?:\/\/\S*brickellpay\.com\S*/i);
  const url = urlm ? (urlm[1] || urlm[0]).replace(/[).,]+$/, "") : cfg.portalUrl;
  return {
    source: "pci_tamper",
    identityKey: `pci:${type}:${shortHash(url)}`,
    severity,
    title: `${severity} · PCI tamper: ${type.toLowerCase()}`,
    url: cfg.portalUrl,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/exposed/pci-tamper.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/exposed/pci-tamper.js daemon/normalizers/exposed/pci-tamper.test.js
git commit -m "feat(daemon): PCI tamper recognizer (pure)"
```

---

### Task 5: Entra digest recognizer (pure, suppresses clean digests)

**Files:**
- Create: `daemon/normalizers/exposed/entra.js`
- Create: `daemon/normalizers/exposed/entra.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/exposed/entra.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeEntra } from "./entra.js";

const cfg = { senderDomains: ["microsoft.com"], senderHints: ["azure-noreply"], subjectMarkers: ["entra id protection", "identity protection"] };

describe("recognizeEntra", () => {
  it("suppresses a clean digest (0 risky users and 0 risky sign-ins)", () => {
    const f = recognizeEntra({
      from: "azure-noreply@microsoft.com",
      subject: "Microsoft Entra ID Protection Weekly Digest",
      preview: "New risky users detected 0 New risky sign-ins detected 0",
    }, cfg);
    assert.equal(f, null);
  });

  it("surfaces a digest with non-zero risky users", () => {
    const f = recognizeEntra({
      from: "azure-noreply@microsoft.com",
      subject: "Microsoft Entra ID Protection Weekly Digest",
      preview: "New risky users detected 3 New risky sign-ins detected 0",
    }, cfg);
    assert.ok(f);
    assert.equal(f.source, "entra");
    assert.match(f.title, /3/);
  });

  it("returns null for a non-Entra email", () => {
    assert.equal(recognizeEntra({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/exposed/entra.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `daemon/normalizers/exposed/entra.js`**

```js
/**
 * exposed/entra.js — pure recognizer for Microsoft Entra ID Protection digests.
 * Suppresses clean digests (0 risky users AND 0 risky sign-ins) by returning
 * null. Surfaces non-zero digests as a High finding linking to the Entra portal.
 */
import { senderMatches } from "./util.js";

export function recognizeEntra(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const users = Number((text.match(/risky users detected\D*(\d+)/i) || [])[1] || 0);
  const signins = Number((text.match(/risky sign-?ins detected\D*(\d+)/i) || [])[1] || 0);
  if (users === 0 && signins === 0) return null; // clean digest → suppress
  return {
    source: "entra",
    identityKey: `entra:${users}u-${signins}s`,
    severity: "High",
    title: `High · Entra: ${users} risky users, ${signins} risky sign-ins`,
    url: cfg.portalUrl || "https://entra.microsoft.com",
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/exposed/entra.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/exposed/entra.js daemon/normalizers/exposed/entra.test.js
git commit -m "feat(daemon): Entra digest recognizer (suppresses clean) (pure)"
```

---

### Task 6: `normalizers/exposed` — run recognizers → deduped items

**Files:**
- Create: `daemon/normalizers/exposed.js`
- Create: `daemon/normalizers/exposed.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/exposed.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeExposed } from "./exposed.js";

const account = { id: "brickell" };
const rules = {
  atRiskSeverities: ["Critical", "High"],
  recognizers: {
    defenderCloud: { senderDomains: ["microsoft.com"], senderHints: ["mssecurity-noreply"], subjectMarkers: ["attack path"], portalUrl: "https://portal.azure.com" },
    defenderEndpoint: { senderDomains: ["microsoft.com"], senderHints: ["defender-noreply"], subjectMarkers: ["vulnerabilit"], portalUrl: "https://security.microsoft.com" },
    pciTamper: { senderDomains: ["brickellpay.com"], subjectMarkers: ["tamper detection"], portalUrl: "https://pci.example/dashboard" },
    entra: { senderDomains: ["microsoft.com"], senderHints: ["azure-noreply"], subjectMarkers: ["entra id protection"] },
  },
};

const emails = [
  { id: "a", from: "MSSecurity-noreply@microsoft.com", subject: "Microsoft Defender for Cloud found potential attack path in your environment", preview: "Risk level: Critical. Attack path ID 7a226bfd-a239-5699-a4dc-0aba63478b99", receivedAt: "2026-06-16T00:00:00Z" },
  { id: "b", from: "defender-noreply@microsoft.com", subject: "New vulnerabilities notification from Microsoft Defender for Endpoint", preview: "Vulnerability Name CVE-2026-48778 Severity High CVSS 7.8 Notepad++", receivedAt: "2026-06-09T00:00:00Z" },
  { id: "c", from: "azure-noreply@microsoft.com", subject: "Microsoft Entra ID Protection Weekly Digest", preview: "New risky users detected 0 New risky sign-ins detected 0", receivedAt: "2026-06-15T00:00:00Z" },
  { id: "d", from: "ar@globex.com", subject: "unrelated", preview: "nothing", receivedAt: "2026-06-15T00:00:00Z" },
];

describe("normalizeExposed", () => {
  it("emits findings for attack-path + CVE, suppresses the clean Entra digest and unrelated mail", () => {
    const items = normalizeExposed(emails, account, rules);
    const keys = items.map(i => i.group.rootCause).sort();
    assert.deepEqual(keys, ["attackpath:7a226bfd-a239-5699-a4dc-0aba63478b99", "cve:CVE-2026-48778"]);
  });

  it("maps Critical/High to at_risk, sets acknowledgeable + link-out source + stable id", () => {
    const items = normalizeExposed(emails, account, rules);
    const cve = items.find(i => i.group.rootCause === "cve:CVE-2026-48778");
    assert.equal(cve.jobType, "exposed");
    assert.equal(cve.status, "at_risk");
    assert.equal(cve.acknowledgeable, true);
    assert.equal(cve.id, "brickell:exposed:cve:CVE-2026-48778");
    assert.ok(cve.source.some(s => s.kind === "url" && /security\.microsoft\.com/.test(s.url)));
  });

  it("dedupes the same finding seen in two emails", () => {
    const dup = [...emails, { ...emails[1], id: "b2", receivedAt: "2026-06-10T00:00:00Z" }];
    const items = normalizeExposed(dup, account, rules);
    assert.equal(items.filter(i => i.group.rootCause === "cve:CVE-2026-48778").length, 1);
  });

  it("returns [] when nothing matches", () => {
    assert.deepEqual(normalizeExposed([emails[3]], account, rules), []);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/exposed.test.js`
Expected: FAIL — cannot find module `./exposed.js`.

- [ ] **Step 3: Implement `daemon/normalizers/exposed.js`**

```js
/**
 * normalizers/exposed.js — pure transform from classified emails to deduped
 * security-finding items. Runs every configured recognizer; dedupes by the
 * finding's identityKey; maps severity → status. Link-out only — exact resource
 * names live in the system of record (Azure portal / PCI dashboard), never here.
 */
import { recognizeDefenderCloud } from "./exposed/defender-cloud.js";
import { recognizeDefenderEndpoint } from "./exposed/defender-endpoint.js";
import { recognizePciTamper } from "./exposed/pci-tamper.js";
import { recognizeEntra } from "./exposed/entra.js";

const RECOGNIZERS = [
  ["defenderCloud", recognizeDefenderCloud],
  ["defenderEndpoint", recognizeDefenderEndpoint],
  ["pciTamper", recognizePciTamper],
  ["entra", recognizeEntra],
];

export function normalizeExposed(emails, account, rules) {
  const atRisk = new Set((rules.atRiskSeverities || ["Critical", "High"]).map(s => s.toLowerCase()));
  const byKey = new Map(); // identityKey -> { finding, members }
  for (const email of emails) {
    for (const [name, fn] of RECOGNIZERS) {
      const cfg = rules.recognizers?.[name];
      if (!cfg) continue;
      const finding = fn(email, cfg);
      if (!finding) continue;
      if (!byKey.has(finding.identityKey)) byKey.set(finding.identityKey, { finding, members: [] });
      byKey.get(finding.identityKey).members.push(email);
      break; // one finding per email
    }
  }

  const items = [];
  for (const [identityKey, { finding, members }] of byKey) {
    items.push({
      id: `${account.id}:exposed:${identityKey}`,
      jobType: "exposed",
      account: account.id,
      title: finding.title,
      status: atRisk.has((finding.severity || "").toLowerCase()) ? "at_risk" : "ok",
      group: {
        rootCause: identityKey,
        severity: finding.severity,
        source: finding.source,
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt })),
      },
      source: [{ kind: "url", url: finding.url }, ...members.map(m => ({ kind: "thread", emailId: m.id }))],
      proposedActions: [],
      acknowledgeable: true,
      lastChanged: null,
    });
  }
  return items;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/exposed.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/exposed.js daemon/normalizers/exposed.test.js
git commit -m "feat(daemon): exposed normalizer (4 recognizers, deduped findings)"
```

---

### Task 7: Register `exposed` in the registry

**Files:**
- Modify: `daemon/normalizers/index.js`
- Modify: `daemon/normalizers/index.test.js`

- [ ] **Step 1: Add the failing test** — append inside `describe("runNormalizers", ...)` in `daemon/normalizers/index.test.js`:

```js
  it("runs the exposed job when configured", async () => {
    const cfg = {
      triageCategories: [{ id: "action", actionable: true }, { id: "ignore", hidden: true }],
      jobTypes: { exposed: { sourceCategories: ["action"], atRiskSeverities: ["Critical", "High"], recognizers: {
        defenderEndpoint: { senderDomains: ["microsoft.com"], senderHints: ["defender-noreply"], subjectMarkers: ["vulnerabilit"], portalUrl: "https://security.microsoft.com" },
      } } },
    };
    const classified = { categories: { action: { emails: [
      { id: "x", from: "defender-noreply@microsoft.com", subject: "New vulnerabilities notification from Microsoft Defender for Endpoint", preview: "CVE-2026-48778 Severity High", receivedAt: "2026-06-09T00:00:00Z" },
    ] } } };
    const items = await runNormalizers(classified, { id: "brickell" }, cfg);
    assert.ok(items.some(i => i.jobType === "exposed" && i.group.rootCause === "cve:CVE-2026-48778"));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/index.test.js`
Expected: FAIL — no `exposed` adapter.

- [ ] **Step 3: Add the adapter in `daemon/normalizers/index.js`**

Add the import (with the others):

```js
import { normalizeExposed } from "./exposed.js";
```

Add an `exposed` adapter to `ADAPTERS`:

```js
  exposed(classified, account, typeConfig) {
    const rules = typeConfig.jobTypes.exposed;
    const emails = flattenSourceEmails(classified, rules.sourceCategories);
    return normalizeExposed(emails, account, rules);
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/index.test.js`
Expected: PASS (existing + new). Full daemon suite → green.

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/index.js daemon/normalizers/index.test.js
git commit -m "feat(daemon): register exposed job in the normalizer registry"
```

---

### Task 8: Docs + verification

**Files:**
- Modify: `daemon/README.md`

- [ ] **Step 1: Update the README**

(a) Intro: change the job list to "the `owed_risk`, `handled`, `gateway`, `audit`, and `exposed` jobs today".

(b) Config section: add a bullet:

```markdown
- `config/account-types.json` → `<type>.jobTypes.exposed.recognizers` (defenderCloud, defenderEndpoint,
  pciTamper, entra — sender domains/hints, subject markers, portal URLs) + `atRiskSeverities`.
```

(c) Add a section after the Audit section:

```markdown
## Exposed (security findings)

The `exposed` job surfaces security findings from four sources — Defender for Cloud attack paths,
Defender for Endpoint CVEs, BrickellPay PCI tamper alerts, and Entra ID Protection digests — deduped
by stable ID (attack-path ID, CVE, PCI type+URL, digest counts), severity-ranked, and acknowledgeable.
Clean Entra digests (0 risky users/sign-ins) are suppressed. Findings link out to the system of record
(Azure portal / PCI dashboard) — exact resource names live there and are never reconstructed. Adding a
fifth security source is a new recognizer under `jobTypes.exposed.recognizers`.
```

- [ ] **Step 2: Verify**

Run: `npm test` → all green.
Run: `node --check daemon/normalizers/exposed.js && for f in defender-cloud defender-endpoint pci-tamper entra util; do node --check daemon/normalizers/exposed/$f.js; done`
Expected: exit 0 for each.

- [ ] **Step 3: Commit**

```bash
git add daemon/README.md
git commit -m "docs(daemon): document the exposed (security findings) job"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** §3 four recognizers (exact senders, dedupe keys: attack-path ID / CVE / PCI type+URL / digest counts; link-out portals) → Tasks 2–5; §5 exposed item shape (id `…:exposed:<identityKey>`, rootCause = identityKey, severity carried, source = portal link + thread refs) → Task 6; severity→status + dedupe + acknowledgeable → Task 6; registry → Task 7; config-driven → Task 1; noise (clean Entra suppressed; PCI sandbox NOT suppressed) → Task 5 + Task 4. Acknowledge reused from Plan 6 (`acknowledgeable: true`). Link-out-never-fabricate honored (titles carry severity + finding class only; exact resources are the portal link).

**Placeholder scan:** no TBD/TODO; complete code per step; the `util.js` creation is folded into Task 2 Step 4 with an explicit note (so `defender-cloud` imports resolve). Every command has expected output.

**Type consistency:** each recognizer returns `{source, identityKey, severity, title, url}` or null; `normalizeExposed` consumes that exact shape and emits the canonical Item (`acknowledgeable: true`, `proposedActions: []`); the panel renders the route link from `source[0]` and the Acknowledge button (Plan 6) from `acknowledgeable`; the scheduler stamps fingerprint + applies acks (Plan 6) unchanged. Registry adapter signature matches the others. `senderMatches`/`severityFrom`/`shortHash` shared via `util.js`.

**Known follow-ups (not gold-plated):** preview truncation can hide an attack-path ID / CVE deep in the body — recognizers fall back to a content hash (still dedupes per distinct email, may under-merge across truncated variants); a per-source "all clear" summary; richer severity for Defender Endpoint via CVSS bands.
```
