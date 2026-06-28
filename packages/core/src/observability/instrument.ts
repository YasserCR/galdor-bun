/**
 * Span instrumentation for providers and tools.
 *
 * Wraps a {@link Provider} or {@link AnyTool} so that every call emits an
 * OpenTelemetry span carrying the `gen_ai.*` and `galdor.*` attributes. The
 * wrappers are OTel-native: supply any TracerProvider/exporter you like, or use
 * the SQLite-backed pipeline from {@link setupTracing}.
 *
 * Parent/child nesting is threaded explicitly through `RunContext.values` under
 * {@link OTEL_CONTEXT_KEY}, so a wrapped call started inside another span nests
 * beneath it without relying on any ambient/global context manager.
 *
 * @module
 */

import {
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import type { RunContext } from "../runtime/context.ts";
import {
  type Capabilities,
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
} from "../provider/index.ts";
import {
  ContentType,
  type Message,
  Role,
  type StopReason,
  textPart,
  thinkingPart,
  type Usage,
} from "../schema/index.ts";
import { type AnyTool, Registry } from "../tool/index.ts";
import {
  AttrGaldorProvider,
  AttrGaldorRunID,
  AttrGaldorSpanLabel,
  AttrGaldorStreaming,
  AttrGenAICompletion,
  AttrGenAIPrompt,
  AttrGenAIReasoning,
  AttrGenAIRequestToolChoice,
  AttrGenAIRequestTools,
  AttrGenAIResponseFinish,
  AttrGenAIResponseModel,
  AttrGenAISystem,
  AttrGenAIRequestModel,
  AttrGenAIToolInputSize,
  AttrGenAIToolName,
  AttrGenAIToolOutputSize,
  AttrGenAIUsageInputTokens,
  AttrGenAIUsageOutputTokens,
  SpanProviderGenerate,
  SpanProviderStream,
  SpanToolExecute,
} from "./attrs.ts";
import { OTEL_CONTEXT_KEY, runIdFromContext, spanLabelFromContext } from "./context.ts";

/** Controls how much call content is recorded onto provider spans. */
export interface InstrumentOptions {
  /**
   * Record request messages and the response message
   * (`gen_ai.prompt`/`gen_ai.completion`). Disabled by default because the
   * payloads may contain personally identifiable information.
   */
  captureContent?: boolean;
  /**
   * Record the model's thinking parts (`gen_ai.reasoning`). Disabled by default
   * because reasoning traces can be sensitive.
   */
  captureReasoning?: boolean;
}

/** The OTel context a new span should parent under, taken from the RunContext. */
function parentContext(ctx: RunContext | undefined): Context {
  const c = ctx?.values?.get(OTEL_CONTEXT_KEY);
  return (c as Context | undefined) ?? ROOT_CONTEXT;
}

/** Builds a child RunContext that exposes `span` as the active OTel context for descendants. */
function withSpan(ctx: RunContext | undefined, parent: Context, span: Span): RunContext {
  const values = new Map(ctx?.values ?? []);
  values.set(OTEL_CONTEXT_KEY, trace.setSpan(parent, span));
  return { ...(ctx ?? {}), values };
}

/** The all-zero trace id OpenTelemetry uses to mark an invalid/absent trace. */
const INVALID_TRACE_ID = "00000000000000000000000000000000";

/**
 * Resolve the run id to stamp on a freshly-started span. An explicit run id
 * carried by the context always wins; otherwise we fall back to the span's OWN
 * trace id. For a root-level call (no parent span) that is the new span's trace
 * id, which guarantees the span still lands in a run bucket the dashboard can
 * group on rather than being stamped with an empty run id. Returns "" only when
 * the span carries the invalid all-zero trace id.
 *
 * @param ctx - The run context, if any.
 * @param span - The newly-created span whose trace id provides the fallback.
 */
function resolveRunId(ctx: RunContext | undefined, span: Span): string {
  const explicit = ctx ? runIdFromContext(ctx) : "";
  if (explicit !== "") return explicit;
  const traceId = span.spanContext().traceId;
  return traceId && traceId !== INVALID_TRACE_ID ? traceId : "";
}

function stampCommon(span: Span, ctx: RunContext | undefined): void {
  const runId = resolveRunId(ctx, span);
  if (runId !== "") span.setAttribute(AttrGaldorRunID, runId);
  const label = ctx ? spanLabelFromContext(ctx) : "";
  if (label !== "") span.setAttribute(AttrGaldorSpanLabel, label);
}

function captureRequest(span: Span, req: Request): void {
  span.setAttribute(AttrGenAIPrompt, JSON.stringify(req.messages));
  if (req.tools && req.tools.length > 0) span.setAttribute(AttrGenAIRequestTools, JSON.stringify(req.tools));
  if (req.toolChoice) span.setAttribute(AttrGenAIRequestToolChoice, req.toolChoice);
}

function encodeThinking(m: Message): string {
  const parts = m.content.filter((p) => p.type === ContentType.Thinking);
  return parts.length > 0 ? JSON.stringify(parts) : "";
}

/**
 * Drop thinking/reasoning parts from a message so they are never folded into
 * the `gen_ai.completion` attribute (reasoning has its own opt-in
 * `gen_ai.reasoning` attribute and may be sensitive).
 */
function withoutThinking(m: Message): Message {
  return { ...m, content: m.content.filter((p) => p.type !== ContentType.Thinking) };
}

/**
 * Encode the completion message for the `gen_ai.completion` attribute, dropping
 * any reasoning parts. Returns `""` when the thinking-stripped message carries
 * nothing worth recording — i.e. no content parts AND no tool calls — so a
 * reasoning-only turn produces no completion attribute, while a turn that only
 * calls tools (no text) still does.
 */
function encodeMessage(m: Message): string {
  const clean = withoutThinking(m);
  if (clean.content.length === 0 && (clean.toolCalls === undefined || clean.toolCalls.length === 0)) {
    return "";
  }
  return JSON.stringify(clean);
}

/**
 * Reconstruct the final assistant message captured during streaming. When the
 * adapter surfaced a complete message on the terminal event we use it verbatim;
 * otherwise we synthesize one from the concatenated text deltas followed by any
 * reasoning parts pulled off the terminal event.
 */
function assembleStreamMessage(
  finalMessage: Message | undefined,
  collectedText: string,
  reasoningParts: string[],
): Message {
  if (finalMessage !== undefined) return finalMessage;
  const content: Message["content"] = [];
  if (collectedText !== "") content.push(textPart(collectedText));
  for (const r of reasoningParts) content.push(thinkingPart(r));
  return { role: Role.Assistant, content };
}

/**
 * Reports whether a message carries any content other than reasoning (text,
 * images, tool calls) — i.e. whether it can stand in as the authoritative
 * completion message rather than a reasoning-only placeholder.
 */
function messageHasNonThinking(m: Message): boolean {
  if (m.toolCalls !== undefined && m.toolCalls.length > 0) return true;
  for (const p of m.content) {
    if (p.type !== ContentType.Thinking) return true;
  }
  return false;
}

/**
 * Wraps a provider so that every `generate` and `stream` call emits a span
 * stamped with the request/response model, token usage, run id and optional
 * content/reasoning attributes.
 *
 * The returned provider delegates `name` and `capabilities` to `inner` and is
 * a drop-in replacement for it.
 *
 * @param inner - The provider to wrap.
 * @param tracer - Tracer used to start spans.
 * @param opts - Content/reasoning capture options. See {@link InstrumentOptions}.
 * @returns A provider that traces each call and otherwise behaves like `inner`.
 * @throws Re-throws any error from the wrapped provider after recording it on the span.
 * @example
 * ```ts
 * const { tracer } = setupTracing("traces.db");
 * const traced = instrumentProvider(baseProvider, tracer, { captureContent: true });
 * const resp = await traced.generate({ model: "m", messages }, ctx);
 * ```
 */
export function instrumentProvider(inner: Provider, tracer: Tracer, opts: InstrumentOptions = {}): Provider {
  return {
    name: () => inner.name(),
    capabilities: (): Capabilities => inner.capabilities(),

    async generate(req: Request, ctx?: RunContext): Promise<Response> {
      const parent = parentContext(ctx);
      const span = tracer.startSpan(
        SpanProviderGenerate,
        {
          attributes: {
            [AttrGenAISystem]: inner.name(),
            [AttrGaldorProvider]: inner.name(),
            [AttrGenAIRequestModel]: req.model,
            [AttrGaldorStreaming]: false,
          },
        },
        parent,
      );
      stampCommon(span, ctx);
      if (opts.captureContent) captureRequest(span, req);
      try {
        const resp = await inner.generate(req, withSpan(ctx, parent, span));
        span.setAttribute(AttrGenAIResponseModel, resp.model);
        span.setAttribute(AttrGenAIResponseFinish, resp.stopReason);
        span.setAttribute(AttrGenAIUsageInputTokens, resp.usage.inputTokens);
        span.setAttribute(AttrGenAIUsageOutputTokens, resp.usage.outputTokens);
        if (opts.captureContent) {
          const completion = encodeMessage(resp.message);
          if (completion !== "") span.setAttribute(AttrGenAICompletion, completion);
        }
        if (opts.captureReasoning) {
          const r = encodeThinking(resp.message);
          if (r !== "") span.setAttribute(AttrGenAIReasoning, r);
        }
        return resp;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },

    async *stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
      const parent = parentContext(ctx);
      const span = tracer.startSpan(
        SpanProviderStream,
        {
          attributes: {
            [AttrGenAISystem]: inner.name(),
            [AttrGaldorProvider]: inner.name(),
            [AttrGenAIRequestModel]: req.model,
            [AttrGaldorStreaming]: true,
          },
        },
        parent,
      );
      stampCommon(span, ctx);
      if (opts.captureContent) captureRequest(span, req);

      // Accumulated during iteration so the span records the same response
      // surface (finish reason, usage, completion, reasoning) a non-streaming
      // call would — making a streamed run replayable from the store.
      let collectedText = ""; // text fragments concatenated when captureContent is on
      const reasoningParts: string[] = []; // thinking text pulled from the terminal event's message
      let finalMessage: Message | undefined; // adopted when the terminal event carries non-reasoning content
      let stop: StopReason | "" = ""; // final stop reason, observed on the terminal event
      let usage: Usage | undefined; // final token usage, observed on the terminal event
      let hasStop = false; // a terminal MessageStop event was seen

      try {
        for await (const ev of inner.stream(req, withSpan(ctx, parent, span))) {
          if (ev.type === EventType.ContentDelta && opts.captureContent) {
            if (ev.contentDelta) collectedText += ev.contentDelta;
          } else if (ev.type === EventType.MessageStop) {
            hasStop = true;
            stop = ev.stopReason ?? "";
            usage = ev.usage;
            if ((opts.captureContent || opts.captureReasoning) && ev.message) {
              // Pull reasoning out regardless of message shape.
              for (const p of ev.message.content) {
                if (p.type === ContentType.Thinking && p.text) reasoningParts.push(p.text);
              }
              // Adopt the terminal message as the authoritative completion only
              // when it carries non-reasoning content (text / tool calls). A
              // reasoning-only message (the streaming-capture case) must NOT
              // displace the text reassembled from deltas.
              if (messageHasNonThinking(ev.message)) finalMessage = ev.message;
            }
          }
          yield ev;
        }
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        if (hasStop) {
          span.setAttribute(AttrGenAIResponseFinish, stop);
          span.setAttribute(AttrGenAIUsageInputTokens, usage?.inputTokens ?? 0);
          span.setAttribute(AttrGenAIUsageOutputTokens, usage?.outputTokens ?? 0);
        }
        if (opts.captureContent || opts.captureReasoning) {
          const msg = assembleStreamMessage(finalMessage, collectedText, reasoningParts);
          if (opts.captureContent) {
            const completion = encodeMessage(msg);
            if (completion !== "") span.setAttribute(AttrGenAICompletion, completion);
          }
          if (opts.captureReasoning) {
            const r = encodeThinking(msg);
            if (r !== "") span.setAttribute(AttrGenAIReasoning, r);
          }
        }
        span.end();
      }
    },
  };
}

/**
 * Wraps a single tool so that each `executeJSON` call emits a span recording
 * the tool name and the byte sizes of its input and output.
 *
 * @param inner - The tool to wrap.
 * @param tracer - Tracer used to start spans.
 * @returns A tool that traces execution and otherwise behaves like `inner`.
 * @throws Re-throws any error from the wrapped tool after recording it on the span.
 */
export function instrumentTool(inner: AnyTool, tracer: Tracer): AnyTool {
  return {
    name: () => inner.name(),
    description: () => inner.description(),
    schema: () => inner.schema(),
    async executeJSON(input, ctx) {
      const parent = parentContext(ctx);
      const inputJSON = JSON.stringify(input ?? null);
      const span = tracer.startSpan(
        SpanToolExecute,
        { attributes: { [AttrGenAIToolName]: inner.name(), [AttrGenAIToolInputSize]: inputJSON.length } },
        parent,
      );
      stampCommon(span, ctx);
      try {
        const out = await inner.executeJSON(input, withSpan(ctx, parent, span));
        span.setAttribute(AttrGenAIToolOutputSize, JSON.stringify(out ?? null).length);
        return out;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },
  };
}

/**
 * Wraps every tool in a registry with {@link instrumentTool}.
 *
 * @param reg - The registry whose tools should be instrumented.
 * @param tracer - Tracer used to start spans.
 * @returns A new {@link Registry} containing instrumented copies of each tool.
 */
export function instrumentRegistry(reg: Registry, tracer: Tracer): Registry {
  return new Registry(...reg.tools().map((t) => instrumentTool(t, tracer)));
}
