/**
 * wiring.js — pure helpers that translate on-disk config into the injected
 * dependencies the daemon needs. Kept separate from daemon.js so they test
 * without spawning subprocesses.
 */
export function resolvePollMs(account, defaultMinutes) {
  const mins = Number.isFinite(account.pollMinutes) ? account.pollMinutes : defaultMinutes;
  return mins * 60 * 1000;
}

/**
 * @param {object[]} accounts            companies[].
 * @param {(account)=>Function} makeSaveDraftFn  factory returning a saveDraftFn(accountId, draft) for an account
 */
export function buildCtxFor(accounts, makeSaveDraftFn) {
  const byId = new Map(accounts.map(a => [a.id, a]));
  return (proposal) => {
    const id = proposal.params?.account;
    const account = byId.get(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    return { account, saveDraftFn: makeSaveDraftFn(account) };
  };
}

/** Fake connectors are opt-in ONLY via env — never default (e2e uses them). */
export function chooseConnectors(env, real, fake) {
  return env.OFFICEOS_FAKE_CONNECTORS === "1" ? fake : real;
}
