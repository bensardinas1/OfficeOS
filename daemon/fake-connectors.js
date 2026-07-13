/**
 * fake-connectors.js — canned-success connector set for the hermetic e2e smoke.
 * ONLY wired when OFFICEOS_FAKE_CONNECTORS === "1" (see wiring.chooseConnectors);
 * never the default. fetchFn throws so the scheduler's stale-retention path keeps
 * the seeded world model intact (accounts flip stale; items persist).
 */
export function makeFakeConnectors() {
  return {
    deleteFn: async (account, ids) => ({ trashed: ids.length, failed: 0 }),
    restoreFn: async (account, ids) => ({ restored: ids.length, failed: 0 }),
    killlistFn: async (account, sender) => ({ added: true, value: sender }),
    killlistRemoveFn: async (account, sender) => ({ removed: true }),
    runTriageFn: async () => ({ ok: true }),
    fetchBodyFn: async (account, emailId) => ({ id: emailId, body: `demo body for ${emailId}` }),
    fetchFn: async () => { throw new Error("fake mode: no live fetch"); },
  };
}
