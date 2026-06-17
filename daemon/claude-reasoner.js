/**
 * claude-reasoner.js — turns a text-returning `runClaude(prompt)` into the
 * reasonerFn the normalizer registry expects: (members) => { emailId: key }.
 * RAILS: reasoning only.
 */
import { buildGroupingPrompt, parseGroupingResponse } from "./reasoner.js";

export function makeReasonerFn(runClaude) {
  return async (members) => {
    const stragglers = members.map(m => ({ id: m.emailId, from: m.from, subject: m.subject }));
    try {
      const out = await runClaude(buildGroupingPrompt(stragglers));
      return parseGroupingResponse(out);
    } catch {
      return {};
    }
  };
}
