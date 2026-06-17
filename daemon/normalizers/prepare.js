/**
 * normalizers/prepare.js — pure per-job email preparation.
 *
 * Two responsibilities:
 *   1. withinLookback  — decide whether a single email falls within the job's
 *      time window (fail-open: keep when window is absent or timestamp missing).
 *   2. prepareEmails   — filter + shallow-copy with body aliased into preview so
 *      every recognizer that reads `preview` automatically sees the fuller body.
 *
 * No side-effects; no mutations of input objects.
 */

/**
 * Returns true when the email should be included in the job's window.
 *
 * Fail-open rules:
 *   - lookbackHours is falsy (0, null, undefined) → always true
 *   - email has no timestamp (received / receivedAt both absent) → always true
 *   - otherwise: timestamp must be >= nowMs − lookbackHours * 3 600 000
 *
 * @param {object} email
 * @param {number} lookbackHours
 * @param {number} nowMs  — Date.now()-style milliseconds
 * @returns {boolean}
 */
export function withinLookback(email, lookbackHours, nowMs) {
  if (!lookbackHours) return true;
  const ts = email.received || email.receivedAt;
  if (!ts) return true;
  const emailMs = Date.parse(ts);
  if (Number.isNaN(emailMs)) return true;
  return emailMs >= nowMs - lookbackHours * 3_600_000;
}

/**
 * Filter emails by the job's lookback window and alias `body` into `preview`.
 *
 * @param {object[]} emails  — input array; not mutated
 * @param {{ lookbackHours?: number, nowMs?: number }} opts
 * @returns {object[]}  — new array of shallow copies
 */
export function prepareEmails(emails, { lookbackHours, nowMs = Date.now() } = {}) {
  const out = [];
  for (const email of emails) {
    if (!withinLookback(email, lookbackHours, nowMs)) continue;
    // shallow copy; alias body into preview when body is present
    out.push({ ...email, preview: email.body || email.preview });
  }
  return out;
}
