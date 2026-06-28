/**
 * core/memory — short-term and long-term memory primitives.
 *
 * Short-term memory keeps the running conversation bounded — by message count
 * or token budget — and feeds the LLM each turn: {@link Window}, with an
 * optional {@link Summarizer} hook to compress overflow instead of dropping it.
 *
 * Long-term memory is the retrieval side: documents are chunked, optionally
 * embedded, and written to a {@link Store}. A {@link Retriever} queries the
 * Store at agent time. {@link InMemoryStore} is the bundled implementation for
 * tests, examples and prototypes.
 *
 * Conventions used throughout this module:
 *  - Dense vectors are plain `number[]`.
 *  - Cancellation is expressed with an optional `signal?: AbortSignal` on every
 *    asynchronous operation.
 *  - Error conditions surface as thrown `Error`s; {@link ErrUnsupported} is an
 *    exported `Error` constant for operations a {@link Store} cannot perform.
 *  - Generated identifiers come from `crypto.randomUUID()`.
 */

import { messageText, type Message, Role, systemMessage } from "../schema/index.ts";

// ── Long-term types ──────────────────────────────────────────────────────────

/**
 * Document is the ingestion unit: source content plus origin and metadata that
 * round-trips through retrieval. Documents are chunked before being written to
 * a {@link Store}; chunks carry a back-reference via {@link Chunk.documentId}.
 */
export interface Document {
  /** Uniquely identifies the document inside a Store. Empty ⇒ Store assigns. */
  id: string;
  /** Human-readable origin (file path, URL, ticket reference). Stored as-is. */
  source: string;
  /** Full document body. Chunkers split this. */
  text: string;
  /** Opaque key/value data preserved on every resulting Chunk. */
  metadata?: Record<string, string>;
  /** When the document was ingested. */
  createdAt?: Date;
}

/**
 * Chunk is the retrieval unit: a span of text small enough to embed and rank,
 * with the metadata needed to reconstruct its origin. A Store contains Chunks.
 */
export interface Chunk {
  /** Uniquely identifies the chunk inside a Store. */
  id: string;
  /** Points back to the parent Document. */
  documentId: string;
  /** The chunk's 0-based ordinal within its parent document. */
  index: number;
  /** The chunk body. */
  text: string;
  /** Dense vector representation of text. Text-only stores may leave it unset. */
  embedding?: number[];
  /** Carries through from the parent Document. */
  metadata?: Record<string, string>;
}

/**
 * Query is a retrieval request. At least one of `text` or `embedding` must be
 * set. Vector-only stores ignore `text`; pure text stores ignore `embedding`.
 */
export interface Query {
  /** Natural-language query. Used by lexical and hybrid stores. */
  text?: string;
  /** Dense vector representation of the query. Required by vector stores. */
  embedding?: number[];
  /** Max results to return. ≤ 0 or unset ⇒ store default (typically 5). */
  k?: number;
  /** When set, restricts results to chunks whose metadata matches every pair. */
  filter?: Record<string, string>;
}

/** Result is one hit from {@link Store.retrieve}. Higher score ⇒ more relevant. */
export interface Result {
  chunk: Chunk;
  score: number;
}

/**
 * Store is the long-term memory interface. Implementations may be lexical,
 * vector, or hybrid. `add` ingests chunks; `retrieve` returns the top-K in
 * descending relevance order; `delete` removes a document's chunks
 * (unsupported backends throw {@link ErrUnsupported}); `close` releases
 * resources and is safe to call repeatedly.
 */
export interface Store {
  add(chunks: Chunk[], signal?: AbortSignal): Promise<void>;
  retrieve(query: Query, signal?: AbortSignal): Promise<Result[]>;
  delete(documentId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/**
 * Embedder turns text into dense vectors. `embed` must preserve input order:
 * `out[i]` is the vector for `texts[i]`. `dimensions` reports the vector size.
 */
export interface Embedder {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  dimensions(): number;
}

/**
 * Sentinel thrown by {@link Store} implementations for operations they do not
 * support (for example a read-only or append-only backend that cannot delete).
 * Discriminate it by reference identity rather than message text.
 */
export const ErrUnsupported = new Error("memory: operation not supported by this Store");

// ── HashingEmbedder ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

/**
 * HashingEmbedder is a deterministic, network-free {@link Embedder} for tests,
 * examples and offline development. It hashes each whitespace-separated token
 * into a fixed-size vector using the "feature hashing" / "hashing trick"
 * (cf. scikit-learn's HashingVectorizer), then L2-normalizes.
 *
 * Quality is not comparable to a trained model — vectors capture lexical
 * overlap, not semantics. Swap in a real embedder when running for real.
 *
 * @example
 * ```ts
 * const embedder = new HashingEmbedder(256);
 * const [vec] = await embedder.embed(["quito ecuador capital"]);
 * // vec.length === 256, L2-normalized
 * ```
 */
export class HashingEmbedder implements Embedder {
  /** Embedding dimensionality (256 is a reasonable default for small corpora). */
  readonly dim: number;

  /**
   * @param dim - Vector size; non-positive values fall back to 256.
   */
  constructor(dim = 256) {
    this.dim = dim > 0 ? dim : 256;
  }

  /** Vector size produced by {@link embed}. */
  dimensions(): number {
    return this.dim > 0 ? this.dim : 256;
  }

  /**
   * Embed each input text into a fixed-size, L2-normalized vector.
   *
   * @param texts - Inputs to embed.
   * @returns One vector per input, in the same order; `out[i]` matches `texts[i]`.
   */
  async embed(texts: string[], _signal?: AbortSignal): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const dim = this.dimensions();
    const vec = new Array<number>(dim).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vec;
    for (const tok of tokens) {
      const sum = createHash("sha256").update(tok).digest();
      // First 4 bytes pick the bucket; the next byte's low bit picks the sign.
      const bucket = sum.readUInt32BE(0) % dim;
      const sign = (sum.readUInt8(4) & 1) === 0 ? -1 : 1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }
    // L2-normalize so cosine reduces to a dot product.
    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    if (sumSq === 0) return vec;
    const inv = 1 / Math.sqrt(sumSq);
    for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) * inv;
    return vec;
  }
}

/** Construct a {@link HashingEmbedder}; non-positive dim falls back to 256. */
export function newHashingEmbedder(dim = 256): HashingEmbedder {
  return new HashingEmbedder(dim);
}

function tokenize(s: string): string[] {
  if (s === "") return [];
  const lower = s.toLowerCase();
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.length > 0) {
      out.push(cur);
      cur = "";
    }
  };
  for (const r of lower) {
    const cp = r.codePointAt(0) ?? 0;
    if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39)) {
      cur += r;
    } else if (cp >= 0x00c0) {
      // Letters with diacritics (rough): keep them.
      cur += r;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

// ── InMemoryStore ────────────────────────────────────────────────────────────

/**
 * InMemoryStore is a {@link Store} backed by an array + index map. For tests,
 * examples and prototypes; it does not persist and is not optimized for scale.
 *
 * Ranking: a query carrying an `embedding` ranks by cosine similarity;
 * otherwise `text` is matched against chunk text with case-insensitive
 * substring scoring (a lightweight lexical approximation).
 *
 * @example
 * ```ts
 * const store = new InMemoryStore();
 * await store.add([{ id: "c1", documentId: "d1", index: 0, text: "Quito is the capital of Ecuador." }]);
 * const hits = await store.retrieve({ text: "capital Ecuador", k: 1 });
 * ```
 */
export class InMemoryStore implements Store {
  #chunks: Chunk[] = [];
  #byID = new Map<string, number>();

  /**
   * Ingest chunks, copying each so later caller mutations don't leak in.
   * A chunk with an empty `id` is assigned a generated UUID; an existing `id`
   * overwrites in place rather than duplicating.
   *
   * @param chunks - Chunks to store.
   */
  async add(chunks: Chunk[], _signal?: AbortSignal): Promise<void> {
    for (const c of chunks) {
      // Store an independent copy: the caller may mutate or reuse the
      // embedding array / metadata object after add returns.
      const stored = cloneChunk(c);
      if (stored.id === "") stored.id = crypto.randomUUID();
      const idx = this.#byID.get(stored.id);
      if (idx !== undefined) {
        this.#chunks[idx] = stored;
        continue;
      }
      this.#byID.set(stored.id, this.#chunks.length);
      this.#chunks.push(stored);
    }
  }

  /**
   * Return the top-K most relevant chunks in descending score order.
   *
   * @param q - Retrieval request; at least one of `text` or `embedding` is required.
   * @returns Matching chunks (cloned) paired with their relevance score.
   * @throws Error when both `text` and `embedding` are empty.
   * @throws Error when a vector query's dimensions don't match a stored chunk.
   */
  async retrieve(q: Query, _signal?: AbortSignal): Promise<Result[]> {
    const hasEmbedding = q.embedding !== undefined && q.embedding.length > 0;
    const hasText = q.text !== undefined && q.text !== "";
    if (!hasText && !hasEmbedding) {
      throw new Error("memory: Query.Text and Query.Embedding both empty");
    }
    let k = q.k ?? 0;
    if (k <= 0) k = 5;

    const results: Result[] = [];
    for (const c of this.#chunks) {
      if (!matchesFilter(c.metadata, q.filter)) continue;
      let score = 0;
      let vector = false;
      if (hasEmbedding) {
        // Vector query: rank by cosine only. A chunk without an embedding is
        // incomparable, so skip it rather than scoring it lexically.
        if (c.embedding === undefined || c.embedding.length === 0) continue;
        score = cosine(q.embedding!, c.embedding);
        vector = true;
      } else if (hasText) {
        score = lexicalScore(q.text!, c.text);
      }
      // Lexical: drop zero-overlap. Vector: keep down to cosine 0; drop only
      // actively dissimilar (negative) entries.
      if (vector) {
        if (score < 0) continue;
      } else if (score <= 0) {
        continue;
      }
      results.push({ chunk: cloneChunk(c), score });
    }
    // Array.sort is stable, so ties keep their original insertion order.
    results.sort((a, b) => b.score - a.score);
    if (results.length > k) results.length = k;
    return results;
  }

  /**
   * Remove every chunk belonging to a document.
   *
   * @param documentId - Parent document whose chunks should be dropped.
   * @throws Error when `documentId` is empty.
   */
  async delete(documentId: string, _signal?: AbortSignal): Promise<void> {
    if (documentId === "") {
      throw new Error("memory: Delete called with empty documentId");
    }
    const kept: Chunk[] = [];
    this.#byID = new Map();
    for (const c of this.#chunks) {
      if (c.documentId === documentId) continue;
      this.#byID.set(c.id, kept.length);
      kept.push(c);
    }
    this.#chunks = kept;
  }

  /** Release resources. A no-op here; safe to call repeatedly. */
  async close(): Promise<void> {
    // no-op
  }

  /** Number of chunks currently stored. Useful for tests; not in Store. */
  len(): number {
    return this.#chunks.length;
  }
}

/** Construct an empty, usable {@link InMemoryStore}. */
export function newInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}

/** Deep copy whose embedding/metadata don't alias the caller's storage. */
function cloneChunk(c: Chunk): Chunk {
  const out: Chunk = {
    id: c.id,
    documentId: c.documentId,
    index: c.index,
    text: c.text,
  };
  if (c.embedding !== undefined) out.embedding = [...c.embedding];
  if (c.metadata !== undefined) out.metadata = { ...c.metadata };
  return out;
}

function matchesFilter(
  meta: Record<string, string> | undefined,
  filter: Record<string, string> | undefined,
): boolean {
  if (filter === undefined) return true;
  for (const key of Object.keys(filter)) {
    const got = meta?.[key] ?? "";
    if (got !== filter[key]) return false;
  }
  return true;
}

/** Cosine similarity in [-1, 1]; 0 for zero-length vectors. Throws on mismatch. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `memory: embedding dimension mismatch: query=${a.length} vs chunk=${b.length}`,
    );
  }
  if (a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Rough term-frequency match in [0, 1]: query tokens found in target / count. */
function lexicalScore(query: string, target: string): number {
  if (query === "" || target === "") return 0;
  const q = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (q.length === 0) return 0;
  const t = target.toLowerCase();
  let hits = 0;
  for (const tok of q) {
    if (t.includes(tok)) hits++;
  }
  return hits / q.length;
}

// ── Retriever ────────────────────────────────────────────────────────────────

/** Options for {@link Retriever}. */
export interface RetrieverOptions {
  store: Store;
  embedder?: Embedder;
  defaultK?: number;
}

/**
 * Retriever composes an {@link Embedder} and a {@link Store}: pass a Query with
 * only `text` set and Retriever fills in `embedding` before delegating. With no
 * embedder, the query is forwarded unchanged.
 *
 * @example
 * ```ts
 * const retriever = new Retriever({ store, embedder, defaultK: 5 });
 * const hits = await retriever.retrieve({ text: "quito ecuador capital" });
 * ```
 */
export class Retriever {
  readonly store: Store;
  readonly embedder?: Embedder;
  readonly defaultK: number;

  /**
   * @param opts - Backing store, optional embedder, and default result count.
   */
  constructor(opts: RetrieverOptions) {
    this.store = opts.store;
    if (opts.embedder !== undefined) this.embedder = opts.embedder;
    this.defaultK = opts.defaultK ?? 0;
  }

  /**
   * Embed `query.text` (when an embedder is set and no embedding is present),
   * apply the default K, then delegate to the backing {@link Store}.
   *
   * @param q - Retrieval request.
   * @returns The store's ranked results.
   * @throws Error when the embedder yields the wrong number of vectors or an
   *   empty vector for the query text.
   */
  async retrieve(q: Query, signal?: AbortSignal): Promise<Result[]> {
    const query: Query = { ...q };
    const hasEmbedding = query.embedding !== undefined && query.embedding.length > 0;
    if (this.embedder !== undefined && !hasEmbedding && query.text !== undefined && query.text !== "") {
      const vecs = await this.embedder.embed([query.text], signal);
      // Exactly one non-empty vector is expected for one input text. Anything
      // else is an embedder contract violation; surface it instead of silently
      // forwarding an embedding-less query.
      if (vecs.length !== 1) {
        throw new Error(`memory: embedder returned ${vecs.length} vectors for 1 query text`);
      }
      const v = vecs[0];
      if (v === undefined || v.length === 0) {
        throw new Error("memory: embedder returned an empty vector for the query text");
      }
      query.embedding = v;
    }
    if (query.k === undefined || query.k <= 0) query.k = this.defaultK;
    return this.store.retrieve(query, signal);
  }
}

// ── Window (short-term memory) ───────────────────────────────────────────────

/**
 * Summarizer compresses a slice of messages into a short paragraph.
 * Implementations typically call an LLM. Errors fall back to dropping.
 */
export interface Summarizer {
  summarize(messages: Message[], signal?: AbortSignal): Promise<string>;
}

/** Options for {@link Window}. */
export interface WindowOptions {
  /** When > 0, caps how many messages the snapshot may contain. */
  maxMessages?: number;
  /** When > 0, caps the snapshot's estimated total token count. */
  maxTokens?: number;
  /** When set, evicted turns are compressed into one system message. */
  summarizer?: Summarizer;
}

/**
 * Window is a bounded short-term memory: a list of messages capped by message
 * count and/or estimated token count. Drive a conversation with {@link append},
 * then {@link snapshot} to obtain the trimmed slice for the next LLM call.
 *
 * Trimming preserves a leading system message and prefers to evict the oldest
 * non-system turns. With a {@link Summarizer}, evicted turns are compressed
 * into a single `name: "summary"` system message instead of being dropped.
 *
 * @example
 * ```ts
 * const window = new Window({ maxMessages: 8 });
 * window.append(userMessage("hello"));
 * const messages = await window.snapshot(); // pass to the next LLM call
 * ```
 */
export class Window {
  readonly maxMessages: number;
  readonly maxTokens: number;
  readonly summarizer?: Summarizer;

  #messages: Message[] = [];
  #summary = "";
  // Serializes snapshot() so two concurrent calls can't double-summarize the
  // same evicted prefix.
  #snapLock: Promise<void> = Promise.resolve();

  /**
   * @param opts - Caps and an optional summarizer; omitted caps mean unbounded.
   */
  constructor(opts: WindowOptions = {}) {
    this.maxMessages = opts.maxMessages ?? 0;
    this.maxTokens = opts.maxTokens ?? 0;
    if (opts.summarizer !== undefined) this.summarizer = opts.summarizer;
  }

  /** Add m to the window. Does not trim; trimming runs in {@link snapshot}. */
  append(m: Message): void {
    this.#messages.push(m);
  }

  /** Add many messages at once. */
  appendAll(ms: Message[]): void {
    for (const m of ms) this.#messages.push(m);
  }

  /**
   * Return the trimmed slice for the next LLM call. The returned array is safe
   * to mutate; internal storage is not aliased. When a Summarizer is set and
   * the window exceeds its caps, the oldest non-system messages are summarized
   * into a single system message prepended to the snapshot.
   */
  async snapshot(signal?: AbortSignal): Promise<Message[]> {
    const prev = this.#snapLock;
    let release!: () => void;
    this.#snapLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await this.#doSnapshot(signal);
    } finally {
      release();
    }
  }

  async #doSnapshot(signal?: AbortSignal): Promise<Message[]> {
    // Step 1: decide the eviction prefix and copy the messages to summarize.
    const [sys, start] = this.#evictionPlan();
    let evictedCopy: Message[] = [];
    if (start > 0 && this.summarizer !== undefined) {
      let body = this.#messages;
      if (sys !== undefined) body = body.slice(1);
      evictedCopy = body.slice(0, start);
    }

    // Step 2: run the Summarizer (an LLM). On error, drop the messages.
    let newSummary = "";
    if (evictedCopy.length > 0 && this.summarizer !== undefined) {
      try {
        newSummary = await this.summarizer.summarize(evictedCopy, signal);
      } catch {
        newSummary = "";
      }
    }

    // Step 3: fold the summary, drop the evicted prefix, rebuild.
    if (newSummary !== "") {
      this.#summary = this.#summary !== "" ? `${this.#summary}\n\n${newSummary}` : newSummary;
    }
    if (start > 0) {
      let curSys = sys;
      let body = this.#messages;
      if (body.length > 0 && body[0]?.role === Role.System) {
        curSys = body[0];
        body = body.slice(1);
      }
      const drop = Math.min(start, body.length);
      const newMsgs: Message[] = [];
      if (curSys !== undefined) newMsgs.push(curSys);
      newMsgs.push(...body.slice(drop));
      this.#messages = newMsgs;
    }
    // Folding the new summary can push the snapshot back over the caps; enforce
    // them again against the post-fold state.
    this.#enforceCaps();
    return this.#buildSnapshot();
  }

  #enforceCaps(): void {
    if (this.maxMessages <= 0 && this.maxTokens <= 0) return;
    const [sys, start] = this.#evictionPlan();
    if (start === 0) return;
    let body = this.#messages;
    if (sys !== undefined) body = body.slice(1);
    const s = Math.min(start, body.length);
    const out: Message[] = [];
    if (sys !== undefined && this.#messages[0] !== undefined) out.push(this.#messages[0]);
    out.push(...body.slice(s));
    this.#messages = out;
  }

  /** Leading system message (if any) and how many oldest messages to evict. */
  #evictionPlan(): [Message | undefined, number] {
    let body = this.#messages;
    let sys: Message | undefined;
    if (body.length > 0 && body[0]?.role === Role.System) {
      sys = body[0];
      body = body.slice(1);
    }
    let start = 0;
    while (start < body.length && !this.#fits(sys, body.slice(start))) {
      start++;
    }
    return [sys, start];
  }

  #buildSnapshot(): Message[] {
    let body = this.#messages;
    let sys: Message | undefined;
    if (body.length > 0 && body[0]?.role === Role.System) {
      sys = body[0];
      body = body.slice(1);
    }
    const out: Message[] = [];
    if (sys !== undefined) out.push(sys);
    if (this.#summary !== "") {
      const summaryMsg = systemMessage(`Conversation summary so far:\n${this.#summary}`);
      summaryMsg.name = "summary";
      out.push(summaryMsg);
    }
    out.push(...body);
    return out;
  }

  /**
   * Whether the proposed snapshot (system + summary + kept) fits both caps.
   * A cap of 0 means "no limit". When a Summarizer is set, a slot is reserved
   * for the summary even before it exists, so eviction doesn't overshoot.
   */
  #fits(sys: Message | undefined, kept: Message[]): boolean {
    const hasSummarySlot = this.#summary !== "" || this.summarizer !== undefined;
    let count = kept.length;
    if (sys !== undefined) count++;
    if (hasSummarySlot) count++;
    if (this.maxMessages > 0 && count > this.maxMessages) return false;
    if (this.maxTokens > 0) {
      let tokens = 0;
      if (sys !== undefined) tokens += estimateTokens(messageText(sys));
      if (this.#summary !== "") tokens += estimateTokens(this.#summary);
      for (const m of kept) tokens += estimateTokens(messageText(m));
      if (tokens > this.maxTokens) return false;
    }
    return true;
  }

  /** Number of messages currently stored (including any leading system). */
  len(): number {
    return this.#messages.length;
  }

  /** Alias of {@link len}. */
  size(): number {
    return this.#messages.length;
  }
}

/**
 * Approximate an LLM tokenizer with a 4-chars-per-token heuristic.
 *
 * Intentionally rough; for accurate counts use a provider-specific tokenizer.
 * The length is measured in UTF-16 code units (`s.length`), which is exact for
 * ASCII and a minor approximation for text outside that range.
 *
 * @param s - Text to estimate.
 * @returns Estimated token count; at least 1 for any non-empty string, 0 for "".
 */
export function estimateTokens(s: string): number {
  if (s === "") return 0;
  const n = Math.floor((s.length + 3) / 4);
  return n < 1 ? 1 : n;
}
