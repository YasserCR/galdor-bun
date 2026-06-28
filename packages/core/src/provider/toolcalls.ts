/**
 * core/provider/toolcalls — the cross-provider tool-call contract.
 *
 * Every adapter must produce tool calls that satisfy a small set of
 * invariants so callers can swap providers without changing tool-handling
 * code. {@link validateToolCalls} enforces them and is a useful sanity check
 * for adapter and contract test suites. It is opt-in: adapters do not call it
 * automatically.
 *
 * The invariants:
 *
 *  1. Each tool call has a non-empty {@link ToolCall.id} and {@link ToolCall.name}.
 *  2. {@link ToolCall.arguments} is either absent (a tool that takes no input)
 *     or an already-parsed JSON value. Because arguments are stored parsed,
 *     a present value is inherently valid JSON.
 *  3. Wire order is preserved (enforced by the adapters, not by this check).
 */

import type { Message } from "../schema/index.ts";
import { GaldorError } from "./errors.ts";

/**
 * Raised by {@link validateToolCalls} when a message violates the
 * cross-provider tool-call contract.
 */
export class ToolCallInvariantError extends GaldorError {
  override name = "ToolCallInvariantError";
}

/**
 * Check that every tool call in `msg` satisfies the cross-provider contract:
 * a non-empty id, a non-empty name, and arguments that are either absent or an
 * already-parsed (hence valid) JSON value.
 *
 * @param msg - The message whose {@link Message.toolCalls} are checked.
 * @returns A {@link ToolCallInvariantError} for the first violation, or `null`
 *   when every tool call is valid (including when there are none).
 */
export function validateToolCalls(msg: Message): ToolCallInvariantError | null {
  const calls = msg.toolCalls ?? [];
  for (let i = 0; i < calls.length; i++) {
    const tc = calls[i]!;
    if (tc.id === "") {
      return new ToolCallInvariantError(
        `provider: tool call invariant violated: tool_calls[${i}] has empty id`,
      );
    }
    if (tc.name === "") {
      return new ToolCallInvariantError(
        `provider: tool call invariant violated: tool_calls[${i}] (id=${JSON.stringify(tc.id)}) has empty name`,
      );
    }
    // Arguments are stored already-parsed: an absent value means the tool
    // takes no input, and any present value is inherently valid JSON, so there
    // is nothing further to reject here.
  }
  return null;
}
