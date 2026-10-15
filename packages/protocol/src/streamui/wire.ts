import { z } from "zod";

// What the hub sends for a streaming UI block. The ops are the model's own op objects, checked for
// well-formedness and capped; the browser runs them through the same reducer the hub used
// (doc.ts), so both sides build the identical tree. `from` is the op index the batch starts at,
// which is what makes a replayed stream idempotent.

/** A cap on the op's own name; the payload is validated by the reducer, prop by prop. */
export const UIWireOpSchema = z.object({ op: z.string().max(16) }).loose();
export type UIWireOp = z.infer<typeof UIWireOpSchema>;

/** Most ops one SSE event may carry; longer runs are split into several events. */
export const UI_OPS_PER_EVENT = 64;

export const UIStatusSchema = z.enum(["streaming", "done", "failed"]);
export type UIStatusValue = z.infer<typeof UIStatusSchema>;
