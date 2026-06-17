/**
 * notifier.js — daemon ambience. Decides whether a tick's diff is worth a
 * toast, and fires a native Windows toast via PowerShell (no module install).
 *
 * RAILS: this module shows notifications only. It never sends or deletes mail.
 */
import { spawnSync } from "node:child_process";

/**
 * @param {object} diff  { newAtRisk: Item[], staleFlips: string[] }
 * @returns {null | {title, body}}
 */
export function decideNotification(diff) {
  const newAtRisk = diff.newAtRisk || [];
  const staleFlips = diff.staleFlips || [];
  if (newAtRisk.length === 0 && staleFlips.length === 0) return null;
  const parts = [];
  if (newAtRisk.length) parts.push(newAtRisk.map(i => i.title).slice(0, 3).join("; "));
  if (staleFlips.length) parts.push(`couldn't refresh: ${staleFlips.join(", ")}`);
  const n = newAtRisk.length;
  return {
    title: n ? `OfficeOS — ${n} need${n === 1 ? "s" : ""} you` : "OfficeOS",
    body: parts.join(" · ") || "Something changed.",
  };
}

// Double single-quotes for safe embedding inside a PowerShell single-quoted string.
function psEsc(s) { return String(s ?? "").replace(/'/g, "''"); }

/**
 * Build a dependency-free PowerShell script that shows a Windows toast.
 * Uses the WinRT ToastNotificationManager with PowerShell's own AppUserModelID,
 * which displays on Windows 10/11 without registering an app or installing a module.
 */
export function buildToastPowerShell(title, body) {
  const aumid = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
    "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    "$t = $x.GetElementsByTagName('text');",
    `$t.Item(0).AppendChild($x.CreateTextNode('${psEsc(title)}')) | Out-Null;`,
    `$t.Item(1).AppendChild($x.CreateTextNode('${psEsc(body)}')) | Out-Null;`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($x);",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${psEsc(aumid)}').Show($toast);`,
  ].join("\n");
}

/**
 * Fire a toast for a diff (no-op when not toast-worthy or when not on Windows).
 * Never throws — notification failure must not break a tick.
 */
export function notify(diff, { platform = process.platform } = {}) {
  const note = decideNotification(diff);
  if (!note) return { shown: false, reason: "nothing-toast-worthy" };
  if (platform !== "win32") return { shown: false, reason: "not-windows" };
  try {
    const ps = buildToastPowerShell(note.title, note.body);
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf-8" });
    return { shown: r.status === 0, reason: r.status === 0 ? "ok" : (r.stderr || "powershell-failed") };
  } catch (err) {
    return { shown: false, reason: err.message };
  }
}
