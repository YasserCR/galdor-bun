/**
 * core/tool — the type-safe tool system.
 *
 * A tool is defined with a **Zod** schema that serves two roles at once:
 *   - the runtime validator for the arguments the model supplies, and
 *   - the source of the JSON Schema advertised to the provider
 *     (via `z.toJSONSchema`).
 *
 * The input type is *inferred* from the Zod schema, so a tool's handler is fully
 * typed from a single declaration — no extra generic parameter is required.
 *
 * The module also provides a {@link Registry} for naming and ordering tools, and
 * {@link executeCalls} for dispatching a batch of model-issued calls and folding
 * the outcomes back into messages with {@link asToolResultMessages}.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * const add = defineTool({
 *   name: "add",
 *   description: "add two numbers",
 *   input: z.object({ a: z.number(), b: z.number() }),
 *   handler: ({ a, b }) => ({ sum: a + b }),
 * });
 * const registry = new Registry(add);
 * const results = await executeCalls(registry, [
 *   { id: "1", name: "add", arguments: { a: 2, b: 3 } },
 * ]);
 * ```
 */

import { z } from "zod";
import {
  type JSONValue,
  type Message,
  type ToolCall,
  type ToolDef,
  toolResultMessage,
} from "../schema/index.ts";
import type { RunContext } from "../provider/index.ts";

/**
 * Raised when raw input fails to validate against a tool's schema.
 *
 * Thrown by {@link AnyTool.executeJSON}; the originating Zod error is attached as
 * the error `cause`.
 */
export class InvalidInputError extends Error {
  override name = "InvalidInputError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(`tool: invalid input: ${message}`, options);
  }
}

/** Raised when a tool call references a name that is not in the registry. */
export class UnknownToolError extends Error {
  override name = "UnknownToolError";
  constructor(name: string) {
    super(`tool: unknown tool: ${name}`);
  }
}

/**
 * Wraps a non-Error value thrown from inside a tool handler so callers always
 * receive an Error.
 *
 * @see executeCalls — which performs this wrapping during dispatch.
 */
export class ToolPanicError extends Error {
  override name = "ToolPanicError";
  /** Name of the tool whose handler threw. */
  readonly tool: string;
  /** The original value that was thrown. */
  readonly value: unknown;
  /**
   * @param tool - Name of the tool whose handler threw.
   * @param value - The raw value that was thrown (anything, not just Errors).
   */
  constructor(tool: string, value: unknown) {
    super(`tool ${tool}: panic recovered: ${String(value)}`);
    this.tool = tool;
    this.value = value;
  }
}

/**
 * Type-erased view of a tool used by the registry, the executor, and provider
 * adapters. {@link defineTool} produces values that satisfy this interface.
 */
export interface AnyTool {
  /** The tool's unique name as advertised to the provider. */
  name(): string;
  /** Human-readable description shown to the model. */
  description(): string;
  /** Already-parsed JSON Schema describing the tool's input. */
  schema(): JSONValue;
  /**
   * Validate raw JSON input against the schema, then run the handler.
   *
   * @param input - Raw arguments as received from the model.
   * @param ctx - Optional run context (carries an abort signal, etc.).
   * @returns The handler's JSON-serializable output.
   * @throws {InvalidInputError} If `input` fails schema validation.
   */
  executeJSON(input: JSONValue, ctx?: RunContext): Promise<JSONValue>;
}

/**
 * A tool that additionally exposes a strongly typed {@link Tool.execute} entry
 * point, preserving compile-time safety on its input and output.
 *
 * @typeParam In - The validated input type inferred from the Zod schema.
 * @typeParam Out - The handler's awaited output type.
 */
export interface Tool<In, Out> extends AnyTool {
  /**
   * Run the handler with already-typed input, bypassing JSON validation.
   *
   * @param input - Arguments already matching the inferred input type.
   * @param ctx - Optional run context.
   */
  execute(input: In, ctx?: RunContext): Promise<Out>;
}

/**
 * Declaration passed to {@link defineTool}.
 *
 * @typeParam Schema - The Zod schema validating and typing the tool's input.
 * @typeParam Out - The handler's return type.
 */
export interface ToolSpec<Schema extends z.ZodType, Out> {
  /** Unique tool name; must be non-empty. */
  name: string;
  /** Optional human-readable description shown to the model. */
  description?: string;
  /** Zod schema that both validates input and yields the JSON Schema. */
  input: Schema;
  /** Function invoked with validated input to produce the tool's result. */
  handler: (input: z.output<Schema>, ctx?: RunContext) => Out | Promise<Out>;
}

/**
 * Build a tool from a Zod input schema and a handler. The JSON Schema is derived
 * once, up front, so it can be advertised to the provider without repeated work.
 *
 * @param spec - The tool declaration; see {@link ToolSpec}.
 * @returns A fully typed {@link Tool} whose input and output types are inferred
 *   from `spec`.
 * @throws {Error} If `spec.name` is empty.
 * @example
 * ```ts
 * const echo = defineTool({
 *   name: "echo",
 *   input: z.object({ text: z.string() }),
 *   handler: ({ text }) => ({ text }),
 * });
 * ```
 */
export function defineTool<Schema extends z.ZodType, Out>(
  spec: ToolSpec<Schema, Out>,
): Tool<z.output<Schema>, Awaited<Out>> {
  if (spec.name === "") throw new Error("tool: name is required");
  if (typeof spec.handler !== "function") throw new Error("tool: handler is required");

  const description = spec.description ?? "";
  const jsonSchema = z.toJSONSchema(spec.input) as JSONValue;

  const execute = async (
    input: z.output<Schema>,
    ctx?: RunContext,
  ): Promise<Awaited<Out>> => {
    return (await spec.handler(input, ctx)) as Awaited<Out>;
  };

  return {
    name: () => spec.name,
    description: () => description,
    schema: () => jsonSchema,
    execute,
    async executeJSON(input: JSONValue, ctx?: RunContext): Promise<JSONValue> {
      const parsed = spec.input.safeParse(input ?? undefined);
      if (!parsed.success) {
        throw new InvalidInputError(parsed.error.message, { cause: parsed.error });
      }
      const out = await execute(parsed.data as z.output<Schema>, ctx);
      return out as JSONValue;
    },
  };
}

/**
 * Name-indexed collection of tools made available to a model.
 *
 * @example
 * ```ts
 * const registry = new Registry(add, subtract);
 * registry.add(multiply);
 * const defs = registry.toolDefs(); // pass to a provider request
 * ```
 */
export class Registry {
  #tools = new Map<string, AnyTool>();

  /**
   * @param tools - Initial tools to register, in any order.
   * @throws {Error} If any tool has an empty or duplicate name.
   */
  constructor(...tools: AnyTool[]) {
    for (const t of tools) this.add(t);
  }

  /**
   * Register a tool.
   *
   * @param t - The tool to add.
   * @returns This registry, for chaining.
   * @throws {Error} If the tool's name is empty or already registered.
   */
  add(t: AnyTool): this {
    if (t == null) throw new Error("registry: nil tool");
    const name = t.name();
    if (name === "") throw new Error("registry: tool has empty name");
    if (this.#tools.has(name)) throw new Error(`registry: duplicate tool name ${name}`);
    this.#tools.set(name, t);
    return this;
  }

  /**
   * Look up a tool by name.
   *
   * @param name - The tool name to resolve.
   * @returns The registered tool, or `undefined` if none matches.
   */
  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  /** Registered tools in stable, name-sorted order. */
  tools(): AnyTool[] {
    return [...this.#tools.values()].sort((a, b) => (a.name() < b.name() ? -1 : 1));
  }

  /** Number of registered tools. */
  get size(): number {
    return this.#tools.size;
  }

  /**
   * Build provider-side tool definitions for a request.
   *
   * @returns One {@link ToolDef} per tool, ordered to match {@link Registry.tools}.
   */
  toolDefs(): ToolDef[] {
    return this.tools().map((t) => ({
      name: t.name(),
      description: t.description(),
      schema: t.schema(),
    }));
  }
}

/** Outcome of running a single {@link ToolCall}. */
export interface Result {
  /** Identifier echoed from the originating tool call. */
  id: string;
  /** Name of the tool that was invoked. */
  name: string;
  /** The tool's output, when it ran successfully. */
  output?: JSONValue;
  /** The failure, when the tool errored or was not found. */
  error?: unknown;
}

/**
 * Convert results into the tool-result messages the assistant expects on its
 * next turn. Errors are surfaced in the message body so the model can recover.
 *
 * @param results - The outcomes produced by {@link executeCalls}.
 * @returns One tool-result {@link Message} per result, in the same order.
 */
export function asToolResultMessages(results: Result[]): Message[] {
  return results.map((r) => {
    let body: string;
    if (r.error !== undefined) {
      body = `error: ${r.error instanceof Error ? r.error.message : String(r.error)}`;
    } else if (r.output === undefined) {
      body = "null";
    } else {
      body = JSON.stringify(r.output);
    }
    return toolResultMessage(r.id, body);
  });
}

/**
 * Dispatch each call to its tool concurrently, preserving input order.
 *
 * An aborted signal short-circuits pending calls with an error result. An
 * exception thrown inside a handler is recovered into {@link Result.error}
 * (wrapped as {@link ToolPanicError} when it isn't already an Error) so a buggy
 * tool can't crash the host — the model still sees a failed result it can react
 * to.
 *
 * @param registry - The {@link Registry} resolving call names to tools.
 * @param calls - The model-issued tool calls to run.
 * @param ctx - Optional run context; an aborted `ctx.signal` cancels dispatch.
 * @returns One {@link Result} per call, in the same order as `calls`.
 * @example
 * ```ts
 * const results = await executeCalls(registry, calls, { signal });
 * const followUp = asToolResultMessages(results);
 * ```
 */
export async function executeCalls(
  registry: Registry,
  calls: ToolCall[],
  ctx?: RunContext,
): Promise<Result[]> {
  if (registry == null) {
    return calls.map((c) => ({
      id: c.id,
      name: c.name,
      error: new Error("tool: nil registry"),
    }));
  }
  return Promise.all(calls.map((c) => executeOne(registry, c, ctx)));
}

async function executeOne(
  registry: Registry,
  call: ToolCall,
  ctx?: RunContext,
): Promise<Result> {
  const res: Result = { id: call.id, name: call.name };
  if (ctx?.signal?.aborted) {
    res.error = ctx.signal.reason ?? new Error("aborted");
    return res;
  }
  const t = registry.get(call.name);
  if (!t) {
    res.error = new UnknownToolError(call.name);
    return res;
  }
  try {
    res.output = await t.executeJSON(call.arguments, ctx);
  } catch (err) {
    // InvalidInputError / UnknownToolError pass through as-is; any other thrown
    // value that isn't an Error is wrapped so callers always get an Error.
    res.error = err instanceof Error ? err : new ToolPanicError(call.name, err);
  }
  return res;
}
