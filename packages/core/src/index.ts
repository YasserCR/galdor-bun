/**
 * `@galdor/core` — the public entrypoint for the library.
 *
 * Each concern is re-exported under its own namespace so callers can reach the
 * pieces they need without deep imports: message {@link schema}, model
 * {@link provider}s, {@link tool} definitions, the scripted
 * {@link testprovider} for tests, the execution {@link graph} and
 * {@link agent} layers, persistent {@link store} and {@link memory}, plus
 * {@link observability}, {@link evaluation}, {@link replay}, {@link embedder},
 * {@link spellbook}, and {@link council}.
 *
 * The {@link RunContext} and {@link Logger} types are also surfaced here for
 * convenience, since most public APIs accept them.
 */

export * as schema from "./schema/index.ts";
export * as provider from "./provider/index.ts";
export * as tool from "./tool/index.ts";
export * as testprovider from "./testprovider/index.ts";
export * as graph from "./graph/index.ts";
export * as agent from "./agent/index.ts";
export * as store from "./store/index.ts";
export * as observability from "./observability/index.ts";
export * as evaluation from "./eval/index.ts";
export * as replay from "./replay/index.ts";
export * as memory from "./memory/index.ts";
export * as embedder from "./embedder/index.ts";
export * as spellbook from "./spellbook/index.ts";
export * as council from "./council/index.ts";
export type { RunContext, Logger } from "./runtime/context.ts";
