/**
 * Canonical span attribute keys and span names used throughout galdor's
 * tracing.
 *
 * Where the OpenTelemetry GenAI semantic conventions define a key (the
 * `gen_ai.*` family) we adopt it verbatim so generic OTel tooling understands
 * our spans out of the box. Dimensions that are specific to galdor are
 * namespaced under `galdor.*`.
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * @module
 */

// gen_ai.* — OpenTelemetry GenAI semantic conventions.
/** Identifier of the model provider that served the request (e.g. the provider name). */
export const AttrGenAISystem = "gen_ai.system";
/** Model requested by the caller. */
export const AttrGenAIRequestModel = "gen_ai.request.model";
/** Model that actually produced the response, as reported by the provider. */
export const AttrGenAIResponseModel = "gen_ai.response.model";
/** Reason the model stopped generating (the response stop reason). */
export const AttrGenAIResponseFinish = "gen_ai.response.finish_reasons";
/** Number of input (prompt) tokens billed for the request. */
export const AttrGenAIUsageInputTokens = "gen_ai.usage.input_tokens";
/** Number of output (completion) tokens billed for the request. */
export const AttrGenAIUsageOutputTokens = "gen_ai.usage.output_tokens";

/** Name of the tool being executed. */
export const AttrGenAIToolName = "gen_ai.tool.name";
/** Byte length of the tool's JSON-encoded input. */
export const AttrGenAIToolInputSize = "gen_ai.tool.input_size_bytes";
/** Byte length of the tool's JSON-encoded output. */
export const AttrGenAIToolOutputSize = "gen_ai.tool.output_size_bytes";

/** JSON-encoded request messages. Emitted only when content capture is enabled (may contain PII). */
export const AttrGenAIPrompt = "gen_ai.prompt";
/** JSON-encoded response message. Emitted only when content capture is enabled (may contain PII). */
export const AttrGenAICompletion = "gen_ai.completion";

/** JSON-encoded list of tools advertised to the model for this request. */
export const AttrGenAIRequestTools = "gen_ai.request.tools";
/** Tool-choice directive sent with the request. */
export const AttrGenAIRequestToolChoice = "gen_ai.request.tool_choice";

/** JSON-encoded thinking parts. Emitted only when reasoning capture is enabled (sensitive). */
export const AttrGenAIReasoning = "gen_ai.reasoning";

// galdor.* — galdor-specific dimensions.
/** Run identifier shared by every span belonging to the same invocation. */
export const AttrGaldorRunID = "galdor.run.id";
/** Name of the graph node a span belongs to. */
export const AttrGaldorNode = "galdor.node.name";
/** Zero-based hop counter within a graph run. */
export const AttrGaldorStep = "galdor.step";
/** Description of the graph state value type. */
export const AttrGaldorStateType = "galdor.state.type";
/** Name of the provider that handled the call. */
export const AttrGaldorProvider = "galdor.provider.name";
/** Whether the provider call was a streaming call. */
export const AttrGaldorStreaming = "galdor.provider.streaming";
/** Optional human-readable label shown alongside the span type. */
export const AttrGaldorSpanLabel = "galdor.span.label";

// Span names — centralized so the dashboard and external pipelines can
// recognize galdor spans by exact name.
/** Span name for a non-streaming provider generate call. */
export const SpanProviderGenerate = "galdor.provider.generate";
/** Span name for a streaming provider call. */
export const SpanProviderStream = "galdor.provider.stream";
/** Span name for a single tool execution. */
export const SpanToolExecute = "galdor.tool.execute";
/** Span name for the root span covering an entire graph run. */
export const SpanGraphRun = "galdor.graph.run";
/** Span name for a single graph node hop. */
export const SpanGraphNode = "galdor.graph.node";
