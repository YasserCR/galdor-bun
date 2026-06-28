/**
 * Reproduce a past agent run from its recorded trace.
 *
 * A {@link ReplayProvider} wraps a list of {@link RecordedCall} values — prompts
 * paired with the responses the real LLM produced — and serves them back during a
 * re-run. Plug it into anything that takes a {@link Provider} and the system
 * behaves as before: no tokens, no network, and (when the model was deterministic
 * at the wire level) no flakiness.
 *
 * Two matching modes:
 *  - "strict" (default): call N must match recording N exactly (by fingerprint).
 *    Fails loudly on drift with a {@link PromptMismatchError}.
 *  - "lenient": match by a SHA-256 fingerprint of the prompt surface. Order
 *    doesn't matter; survives graph restructurings as long as the same prompts
 *    surface.
 *
 * Loading sources:
 *  - {@link loadFromFile} / {@link saveToFile} — portable JSON fixture format.
 *  - {@link loadFromStore} — reconstructs calls from captured trace spans.
 *  - Or build a `RecordedCall[]` by hand for unit tests.
 *
 * Implementation notes:
 *  - The fingerprint folds in model + prompt messages + tools + tool-choice and
 *    SHA-256s a canonical JSON encoding: object keys are sorted recursively and
 *    absent optional fields are normalized away so an unset and an empty/zero
 *    field hash identically, regardless of how the value was built.
 *  - `stream` replays as well as `generate`, synthesizing a MessageStart /
 *    ContentDelta / ToolCallDelta / MessageStop sequence from the recorded
 *    response.
 *  - {@link loadFromStore} takes an already-opened {@link Store}. It is
 *    best-effort and coupled to the observability attribute layout (`gen_ai.*`);
 *    the file fixture path is the canonical, fully-supported route.
 *
 * @example
 * ```ts
 * const rec = await loadFromFile("fixtures/run.json");
 * const provider = new ReplayProvider(rec.calls, "strict");
 * const resp = await provider.generate({ model: "m", messages: [userMessage("hi")] });
 * ```
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
  type Capabilities,
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
  type RunContext,
  type ToolChoice,
} from "../provider/index.ts";
import {
  ContentType,
  type ContentPart,
  type ImageContent,
  type Message,
  type StopReason,
  type ToolCall,
  type ToolDef,
} from "../schema/index.ts";
import type { Store } from "../store/index.ts";

// ── Mode ───────────────────────────────────────────────────────────────────

/**
 * Discriminates how a {@link ReplayProvider} matches an incoming request
 * against its recorded calls.
 *
 *  - "strict"  — the Nth incoming call must match the Nth recorded call.
 *  - "lenient" — look the response up by prompt fingerprint, order-independent.
 */
export type Mode = "strict" | "lenient";

// ── Data ───────────────────────────────────────────────────────────────────

/**
 * One observation from a prior run: the messages sent to the provider plus the
 * response that came back. Round-trips cleanly through fixture files.
 */
export interface RecordedCall {
  /** Identifies the source span, when known. Informational; not matched on. */
  spanId?: string;
  /** Model ID the recorded call targeted. Folded into the fingerprint. */
  model?: string;
  /** Messages the recorded request carried. */
  prompt: Message[];
  /** Tool set the recorded request advertised. Folded into the fingerprint. */
  tools?: ToolDef[];
  /** Tool-choice constraint the recorded request carried. Folded into the fingerprint. */
  toolChoice?: ToolChoice;
  /** Answer the real provider returned. */
  response: Response;
}

/**
 * A versioned bundle of recorded calls, ready to be serialized to a fixture
 * file. Fields beyond `calls` are metadata, useful for diffing fixtures.
 */
export interface Recording {
  /** Fixture schema version. Bumped on breaking changes. */
  version: number;
  /** Source run id, when loaded from a trace store. */
  runId?: string;
  /** Free-form text (e.g. the dataset or agent version that produced this). */
  note?: string;
  /** Ordered list of observed generate calls. */
  calls: RecordedCall[];
}

/**
 * Version tag stamped onto recordings written by this package. The fingerprint
 * folds in tools, tool-choice and model, so recordings written before that
 * surface was added hash their prompts differently; the loader rejects any
 * fixture whose version doesn't match this value.
 */
export const CURRENT_FIXTURE_VERSION = 2;

// ── Errors ───────────────────────────────────────────────────────────────────

/** Thrown by `generate` in strict mode when the incoming prompt doesn't match. */
export class PromptMismatchError extends Error {
  override name = "PromptMismatchError";
  readonly call: number;
  readonly expected: string;
  readonly got: string;
  constructor(call: number, expected: string, got: string) {
    super(`replay: prompt does not match next recorded call: call ${call} expected fingerprint ${short(expected)}, got ${short(got)}`);
    this.call = call;
    this.expected = expected;
    this.got = got;
  }
}

/** Thrown by `generate` in lenient mode when no recorded call matches. */
export class UnknownPromptError extends Error {
  override name = "UnknownPromptError";
  readonly fingerprint: string;
  constructor(fingerprint: string) {
    super(`replay: no recorded call matches this prompt: fingerprint ${short(fingerprint)}`);
    this.fingerprint = fingerprint;
  }
}

/** Thrown by `generate` (strict) when the recording has no more entries to serve. */
export class ExhaustedError extends Error {
  override name = "ExhaustedError";
  readonly requested: number;
  readonly recorded: number;
  constructor(requested: number, recorded: number) {
    super(`replay: recording exhausted: requested call ${requested}, only ${recorded} recorded`);
    this.requested = requested;
    this.recorded = recorded;
  }
}

/** Thrown when a matched recorded call carries no response, so callers never dereference a missing value. */
export class NilResponseError extends Error {
  override name = "NilResponseError";
  constructor(message = "replay: recorded call has a nil response") {
    super(message);
  }
}

/** Thrown by `loadFromFile` when the fixture's version is unsupported. */
export class FixtureVersionError extends Error {
  override name = "FixtureVersionError";
  readonly got: number;
  readonly want: number;
  constructor(got: number, want: number) {
    super(`replay: fixture version ${got} unsupported (want ${want})`);
    this.got = got;
    this.want = want;
  }
}

/** Thrown/skipped when a span lacks the captured prompt/completion attributes replay needs. */
export class NoContentError extends Error {
  override name = "NoContentError";
  constructor(message = "replay: span has no captured content (run with capture-content enabled)") {
    super(message);
  }
}

// ── Fingerprinting ────────────────────────────────────────────────────────────

/**
 * Stable SHA-256 (hex) over the matching-relevant surface of a recorded call:
 * model, prompt messages, tool set and tool-choice constraint. Two calls with
 * the same surface produce the same fingerprint; small reorderings inside nested
 * JSON objects (tool schemas, tool-call arguments) don't change it because the
 * canonical encoder sorts keys.
 *
 * @param call - The recorded call to fingerprint.
 * @returns Lowercase hex SHA-256 of the call's matching surface.
 */
export function fingerprint(call: RecordedCall): string {
  return fingerprintSurface(call.model, call.prompt, call.tools, call.toolChoice);
}

/** Fingerprints an incoming request using the same surface as {@link fingerprint}. */
function fingerprintRequest(req: Request): string {
  return fingerprintSurface(req.model, req.messages, req.tools, req.toolChoice);
}

function fingerprintSurface(
  model: string | undefined,
  messages: Message[] | undefined,
  tools: ToolDef[] | undefined,
  toolChoice: ToolChoice | undefined,
): string {
  const envelope = {
    model: model ?? "",
    messages: (messages ?? []).map(normMessage),
    tools: (tools ?? []).map(normTool),
    toolChoice: toolChoice ?? "",
  };
  return createHash("sha256").update(encodeStable(envelope)).digest("hex");
}

/**
 * Deterministic JSON encoding with object keys sorted recursively, so two
 * envelopes describing the same surface always serialize byte-for-byte
 * identically. The normalized envelope is already JSON-safe (no undefined, bytes
 * pre-encoded to base64), so this only needs to order keys and serialize.
 */
function encodeStable(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(encodeStable).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${encodeStable(obj[k])}`).join(",")}}`;
}

// Normalizers drop absent/empty optional fields so an unset field and an
// empty/zero one hash identically, regardless of how the value was built.

function normMessage(m: Message): Record<string, unknown> {
  const o: Record<string, unknown> = {
    role: m.role,
    content: (m.content ?? []).map(normPart),
  };
  if (m.name) o.name = m.name;
  if (m.toolCalls && m.toolCalls.length > 0) o.toolCalls = m.toolCalls.map(normToolCall);
  if (m.toolCallId) o.toolCallId = m.toolCallId;
  if (m.cacheControl) o.cacheControl = m.cacheControl;
  return o;
}

function normPart(p: ContentPart): Record<string, unknown> {
  const o: Record<string, unknown> = { type: p.type };
  if (p.text) o.text = p.text;
  if (p.image) o.image = normImage(p.image);
  if (p.signature) o.signature = p.signature;
  return o;
}

function normImage(img: ImageContent): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (img.url) o.url = img.url;
  // Encode raw bytes as base64 so binary image data hashes stably.
  if (img.data && img.data.length > 0) o.data = Buffer.from(img.data).toString("base64");
  if (img.media) o.media = img.media;
  return o;
}

function normTool(t: ToolDef): Record<string, unknown> {
  const o: Record<string, unknown> = { name: t.name, schema: t.schema ?? null };
  if (t.description) o.description = t.description;
  return o;
}

function normToolCall(tc: ToolCall): Record<string, unknown> {
  return { id: tc.id, name: tc.name, arguments: tc.arguments ?? null };
}

function short(fp: string): string {
  return fp.length <= 12 ? fp : fp.slice(0, 12);
}

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * A {@link Provider} backed by a recording. `generate` serves recorded responses
 * — strict mode by position (with fingerprint verification), lenient mode by
 * fingerprint lookup. `stream` replays the matched response as a synthetic event
 * stream.
 */
export class ReplayProvider implements Provider {
  readonly #calls: RecordedCall[];
  readonly #mode: Mode;
  #idx = 0;

  // Lenient mode only: fingerprint → ordered queue of call indices, plus a
  // per-fingerprint cursor so calls sharing a fingerprint replay in order.
  readonly #fingerprints: Map<string, number[]>;
  readonly #cursors: Map<string, number>;

  /**
   * @param calls - The recorded calls to replay; copied defensively so later
   *   external mutation can't affect playback.
   * @param mode - "strict" matches by position, "lenient" by fingerprint lookup.
   */
  constructor(calls: RecordedCall[], mode: Mode = "strict") {
    // Copy defensively so external mutation can't affect playback.
    this.#calls = calls.slice();
    this.#mode = mode;
    this.#fingerprints = new Map();
    this.#cursors = new Map();
    if (mode === "lenient") {
      this.#calls.forEach((c, i) => {
        const fp = fingerprint(c);
        const q = this.#fingerprints.get(fp);
        if (q) q.push(i);
        else this.#fingerprints.set(fp, [i]);
      });
    }
  }

  /** Stable identifier for this provider. */
  name(): string {
    return "replay";
  }

  /** Capability flags: streaming and tool-calling are supported; generation features are not. */
  capabilities(): Capabilities {
    return {
      // `stream` replays a synthetic event stream from the recorded response,
      // so streaming is advertised as supported.
      streaming: true,
      // Recorded responses already carry whatever tool calls the run produced.
      toolCalling: true,
      structuredOutput: false,
      promptCaching: false,
      visionInput: false,
      reasoning: false,
      maxContextTokens: 0,
    };
  }

  /**
   * Serve the recorded response for `req`: by position in strict mode (verifying
   * the fingerprint), by fingerprint lookup in lenient mode.
   *
   * @param req - The incoming request to match against the recording.
   * @param ctx - Optional run context; an aborted signal rejects immediately.
   * @returns A defensive deep copy of the matched recorded response.
   * @throws PromptMismatchError (strict) when the prompt doesn't match the next call.
   * @throws ExhaustedError (strict) when no recorded calls remain.
   * @throws UnknownPromptError (lenient) when no recorded call matches the prompt.
   * @throws NilResponseError when the matched call has no response.
   */
  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    ctx?.signal?.throwIfAborted();
    return this.#mode === "lenient" ? this.#generateLenient(req) : this.#generateStrict(req);
  }

  #generateStrict(req: Request): Response {
    const idx = this.#idx;
    this.#idx++;
    if (idx >= this.#calls.length) {
      throw new ExhaustedError(idx + 1, this.#calls.length);
    }
    const rec = this.#calls[idx]!;
    const want = fingerprint(rec);
    const got = fingerprintRequest(req);
    if (want !== got) {
      throw new PromptMismatchError(idx + 1, want, got);
    }
    return responseOrThrow(rec.response);
  }

  #generateLenient(req: Request): Response {
    const fp = fingerprintRequest(req);
    const queue = this.#fingerprints.get(fp);
    if (!queue || queue.length === 0) {
      throw new UnknownPromptError(fp);
    }
    // Serve calls sharing a fingerprint in recorded order, clamping to the last
    // once drained so a repeated prompt keeps replaying its final response.
    let cur = this.#cursors.get(fp) ?? 0;
    if (cur >= queue.length) {
      cur = queue.length - 1;
    } else {
      this.#cursors.set(fp, cur + 1);
    }
    return responseOrThrow(this.#calls[queue[cur]!]!.response);
  }

  /**
   * Replay the matched response as a synthetic event stream. Consumes a recorded
   * call exactly as {@link ReplayProvider.generate} does, then emits a
   * MessageStart, text/tool-call deltas, and a terminal MessageStop.
   *
   * @param req - The incoming request to match against the recording.
   * @param ctx - Optional run context; an aborted signal rejects immediately.
   * @returns An async stream of {@link Event} values.
   */
  async *stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
    // Reuse the matching logic (and counter advance) of generate, then synthesize
    // a stream from the matched response — text deltas, then tool-call deltas,
    // then a terminal MessageStop carrying the full assembled message.
    const resp = await this.generate(req, ctx);
    const model = resp.model || req.model;

    yield { type: EventType.MessageStart, model, usage: resp.usage };

    for (const part of resp.message.content) {
      if (part.type === ContentType.Text && part.text) {
        yield { type: EventType.ContentDelta, contentDelta: part.text };
      }
    }
    for (const tc of resp.message.toolCalls ?? []) {
      yield {
        type: EventType.ToolCallDelta,
        toolCallDelta: {
          id: tc.id,
          name: tc.name,
          argumentsDelta: JSON.stringify(tc.arguments ?? {}),
        },
      };
    }
    yield {
      type: EventType.MessageStop,
      stopReason: resp.stopReason,
      usage: resp.usage,
      model: resp.model,
      message: resp.message,
    };
  }

  /**
   * How many recorded calls have not been served yet (strict mode only —
   * lenient mode reuses fingerprints freely). Useful for asserting every
   * recorded call was exercised.
   */
  remaining(): number {
    return this.#idx >= this.#calls.length ? 0 : this.#calls.length - this.#idx;
  }

  /** Rewind a strict-mode provider's counter so the recording can drive another replay. */
  reset(): void {
    this.#idx = 0;
  }
}

/** Deep-clone so callers can mutate the returned value without poisoning the recording. */
function responseOrThrow(r: Response | undefined): Response {
  if (r === undefined || r === null) throw new NilResponseError();
  return structuredClone(r);
}

// ── Loaders ───────────────────────────────────────────────────────────────────

/**
 * Write a recording to `path` as indented JSON. The fixture format is the
 * {@link Recording} shape verbatim, so files can be hand-edited and re-loaded.
 *
 * @param path - Destination file path.
 * @param rec - Recording to serialize; a `version` of 0 is stamped with
 *   {@link CURRENT_FIXTURE_VERSION} before writing.
 */
export async function saveToFile(path: string, rec: Recording): Promise<void> {
  const out: Recording = rec.version === 0 ? { ...rec, version: CURRENT_FIXTURE_VERSION } : rec;
  await writeFile(path, JSON.stringify(out, null, 2));
}

/**
 * Read and validate a recording fixture from disk.
 *
 * @param path - Fixture file path.
 * @returns The parsed {@link Recording}.
 * @throws Error if the file can't be read or parsed as JSON.
 * @throws FixtureVersionError if the fixture version isn't {@link CURRENT_FIXTURE_VERSION}.
 * @throws NilResponseError if any recorded call is missing its response.
 */
export async function loadFromFile(path: string): Promise<Recording> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`replay: read ${path}: ${(err as Error).message}`);
  }
  let rec: Recording;
  try {
    rec = JSON.parse(raw) as Recording;
  } catch (err) {
    throw new Error(`replay: decode ${path}: ${(err as Error).message}`);
  }
  if (rec.version !== CURRENT_FIXTURE_VERSION) {
    throw new FixtureVersionError(rec.version, CURRENT_FIXTURE_VERSION);
  }
  rec.calls.forEach((c, i) => {
    if (c.response === undefined || c.response === null) {
      throw new NilResponseError(`replay: ${path}: call ${i + 1} has a nil response`);
    }
  });
  return rec;
}

export interface LoadFromStoreOptions {
  /** Free-form note recorded into the resulting {@link Recording}. */
  note?: string;
  /** Cancellation. */
  signal?: AbortSignal;
}

// OpenTelemetry / observability attribute keys read off captured provider spans.
const ATTR = {
  prompt: "gen_ai.prompt",
  completion: "gen_ai.completion",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseFinish: "gen_ai.response.finish_reasons",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  requestTools: "gen_ai.request.tools",
  requestToolChoice: "gen_ai.request.tool_choice",
} as const;

const SPAN_PROVIDER_GENERATE = "galdor.provider.generate";
const SPAN_PROVIDER_STREAM = "galdor.provider.stream";

/**
 * Reconstruct a recording from captured trace spans for `runId`, in recorded
 * order (sorted by span start time). Includes both generate and stream provider
 * spans (both carry the same captured prompt/completion).
 *
 * Best-effort and coupled to the observability attribute layout: the spans must
 * carry `gen_ai.prompt` / `gen_ai.completion` bodies (recorded with
 * capture-content enabled). Spans missing those are skipped as no-content; if
 * none remain a {@link NoContentError} is thrown.
 *
 * @param store - An already-opened trace store to read spans from.
 * @param runId - The run whose provider spans should be reconstructed.
 * @param opts - Optional note text and abort signal.
 * @returns A {@link Recording} whose calls are ordered by span start time.
 * @throws Error if `runId` is empty or the run has no provider spans.
 * @throws NoContentError if no span carries replayable captured content.
 */
export function loadFromStore(store: Store, runId: string, opts: LoadFromStoreOptions = {}): Recording {
  opts.signal?.throwIfAborted();
  if (runId === "") throw new Error("replay: runId is empty");

  const spans = store.spansForRun(runId);
  if (spans.length === 0) {
    throw new Error(`replay: no spans found for run ${JSON.stringify(runId)}`);
  }

  const providerSpans = spans
    .filter((sp) => sp.name === SPAN_PROVIDER_GENERATE || sp.name === SPAN_PROVIDER_STREAM)
    .sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0));
  if (providerSpans.length === 0) {
    throw new Error(
      `replay: run ${JSON.stringify(runId)} has no provider.generate or provider.stream spans`,
    );
  }

  const calls: RecordedCall[] = [];
  for (const sp of providerSpans) {
    const call = callFromSpan(sp);
    // A call that errored has no captured completion; skip rather than fail all.
    if (call !== null) calls.push(call);
  }
  if (calls.length === 0) {
    throw new NoContentError(
      `replay: run ${JSON.stringify(runId)} has no replayable calls (record with capture-content enabled and ensure calls succeeded)`,
    );
  }

  const rec: Recording = { version: CURRENT_FIXTURE_VERSION, runId, calls };
  if (opts.note) rec.note = opts.note;
  return rec;
}

interface SpanLike {
  spanId: string;
  name: string;
  attributes: Record<string, unknown>;
}

/** Decode one provider span into a RecordedCall; null when it lacks captured content. */
function callFromSpan(sp: SpanLike): RecordedCall | null {
  const promptRaw = stringAttr(sp.attributes, ATTR.prompt);
  const completionRaw = stringAttr(sp.attributes, ATTR.completion);
  if (promptRaw === "" || completionRaw === "") return null;

  const prompt = JSON.parse(promptRaw) as Message[];
  const completion = JSON.parse(completionRaw) as Message;

  const response: Response = {
    message: completion,
    stopReason: stringAttr(sp.attributes, ATTR.responseFinish) as StopReason,
    model: stringAttr(sp.attributes, ATTR.responseModel),
    usage: {
      inputTokens: intAttr(sp.attributes, ATTR.inputTokens),
      outputTokens: intAttr(sp.attributes, ATTR.outputTokens),
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };

  const call: RecordedCall = {
    spanId: sp.spanId,
    model: stringAttr(sp.attributes, ATTR.requestModel),
    prompt,
    response,
  };

  // Tools + tool_choice are folded into the fingerprint, so a tool-using fixture
  // must carry them back or it can never match a live run.
  const toolsRaw = stringAttr(sp.attributes, ATTR.requestTools);
  if (toolsRaw !== "") {
    call.tools = JSON.parse(toolsRaw) as ToolDef[];
  }
  const tc = stringAttr(sp.attributes, ATTR.requestToolChoice);
  if (tc !== "") {
    call.toolChoice = tc as ToolChoice;
  }
  return call;
}

function stringAttr(attrs: Record<string, unknown>, key: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : "";
}

function intAttr(attrs: Record<string, unknown>, key: string): number {
  const v = attrs[key];
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  return 0;
}
