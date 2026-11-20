// The same masker Guard uses for outgoing model calls. Bundled by esbuild from
// the engine source so the two can never drift.
export { maskOutgoing } from "../../../engine/src/mask/mask.ts";
export type { MaskResult } from "../../../engine/src/mask/mask.ts";
