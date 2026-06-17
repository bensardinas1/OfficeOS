/**
 * route.js — "route:<linkName>" executor. Returns a URL to the system of
 * record. The cheapest handler; escalating to a real API call later means
 * swapping this for an execute-kind executor without touching the surface.
 */
export function routeExecutor(linkName) {
  return async (proposal, ctx) => {
    const url = ctx.account?.links?.[linkName];
    if (!url) throw new Error(`route target not configured: links.${linkName} for ${ctx.account?.id}`);
    return { kind: "route", url };
  };
}
