// The streaming UI DSL: a declarative, streamable description of an interface that an agent writes
// and the platform renders. See schema.ts for the limits and actions, doc.ts for the state tree and
// the reducer, wire.ts for what travels over SSE.

export * from "./schema.ts";
export * from "./doc.ts";
export * from "./wire.ts";
