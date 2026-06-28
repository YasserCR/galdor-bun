/**
 * core/provider/capabilities — a defensive request/capability check.
 *
 * {@link validateRequest} compares a {@link Request} against a provider's
 * advertised {@link Capabilities} and reports the first feature the request
 * needs but the provider does not offer. It is an opt-in helper: provider
 * adapters do not call it automatically. Use it at a call boundary when you
 * want a single, backend-neutral pre-flight check before sending the request
 * over the wire.
 */

import { ContentType, type Message } from "../schema/index.ts";
import { UnsupportedError } from "./errors.ts";
import type { Capabilities, Request } from "./index.ts";

/**
 * Check whether `req` can be served given `caps`, returning an
 * {@link UnsupportedError} describing the first mismatch or `null` when the
 * request fits.
 *
 * The checks run in a fixed order and stop at the first failure:
 *
 *   - tools supplied but {@link Capabilities.toolCalling} is false
 *   - a response format requested but {@link Capabilities.structuredOutput} is false
 *   - an image content part present but {@link Capabilities.visionInput} is false
 *   - a cache-control hint present but {@link Capabilities.promptCaching} is false
 *   - reasoning enabled but {@link Capabilities.reasoning} is false
 *
 * Streaming is not validated here; a provider whose
 * {@link Capabilities.streaming} is false rejects streaming on its own.
 *
 * @param caps - The provider's advertised capabilities.
 * @param req - The request to validate.
 * @returns An {@link UnsupportedError} for the first mismatch, or `null` if the request fits.
 */
export function validateRequest(caps: Capabilities, req: Request): UnsupportedError | null {
  if (req.tools !== undefined && req.tools.length > 0 && !caps.toolCalling) {
    return unsupported(
      `provider does not support tool calling but request.tools has ${req.tools.length} entries`,
    );
  }
  if (req.responseFormat !== undefined && !caps.structuredOutput) {
    return unsupported(
      "provider does not support structured outputs but request.responseFormat is set",
    );
  }
  if (hasImageInput(req.messages) && !caps.visionInput) {
    return unsupported(
      "provider does not support vision input but request.messages contains image parts",
    );
  }
  if (hasCacheControl(req.messages) && !caps.promptCaching) {
    return unsupported(
      "provider does not support prompt caching but request.messages carries cache-control hints",
    );
  }
  if (req.reasoning !== undefined && req.reasoning.enabled && !caps.reasoning) {
    return unsupported("provider does not support reasoning but request.reasoning is enabled");
  }
  return null;
}

/** Build an {@link UnsupportedError} for a capability mismatch. */
function unsupported(message: string): UnsupportedError {
  return new UnsupportedError({ kind: "unsupported", provider: "", statusCode: 0, message });
}

/** Report whether any message carries an image content part. */
function hasImageInput(msgs: Message[]): boolean {
  for (const m of msgs) {
    for (const p of m.content) {
      if (p.type === ContentType.Image) return true;
    }
  }
  return false;
}

/** Report whether any message carries a cache-control hint. */
function hasCacheControl(msgs: Message[]): boolean {
  for (const m of msgs) {
    if (m.cacheControl !== undefined) return true;
  }
  return false;
}
