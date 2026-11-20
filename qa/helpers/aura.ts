// What a Guard QA spec imports. The real code lives in engine/src/qa/harness.ts so it is type-checked
// with the engine; this file is the stable path specs use:  import { journey } from "../helpers/aura.ts";
//
// HARD RULES: specs only READ. They attach to an Aura the owner already started with a debugging port
// (AURA_CDP_URL) and never launch it. The page you get is guarded: click/fill/press re-check the target
// against qa/forbidden-actions.json and throw before acting. Guard never writes into the Aura repo.
export { journey, ForbiddenActionError, DEFAULT_WIDTHS, CDP_ENV, attachAura, guardPage, makeContext } from "../../engine/src/qa/harness.ts";
export type { JourneyContext, JourneyFn } from "../../engine/src/qa/harness.ts";
