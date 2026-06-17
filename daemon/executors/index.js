/**
 * index.js — executor registry. Maps an action name to an executor function.
 * Action names are either exact ("draft_chase") or "route:<linkName>".
 */
import { routeExecutor } from "./route.js";
import { draftChaseExecutor } from "./draft-chase.js";

export function resolveExecutor(action) {
  if (action === "draft_chase") return draftChaseExecutor;
  if (action.startsWith("route:")) return routeExecutor(action.slice("route:".length));
  throw new Error(`unknown action: ${action}`);
}
