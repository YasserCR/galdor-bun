/**
 * core/council/shared — small helpers used by both council runtimes.
 */

/**
 * Reports whether `s` is a valid worker / agent name, i.e. matches
 * `[A-Za-z0-9_-]+`. The constraint keeps names safe to embed in JSON and to use
 * as graph-node identifiers.
 *
 * @param s The candidate name.
 * @returns `true` when `s` is non-empty and contains only the allowed characters.
 */
export function isSafeWorkerName(s: string): boolean {
  return s !== "" && /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Strips a leading/trailing Markdown code fence (```json … ``` or plain ```)
 * that a model may wrap around its reply despite instructions not to. Kept local
 * to this module so council carries no dependency on the agent layer.
 *
 * @param s The raw model text.
 * @returns The fence-free body, or `s` unchanged when no opening fence is found.
 */
export function stripFences(s: string): string {
  let t = s.trim();
  if (!t.startsWith("```")) return s;
  const nl = t.indexOf("\n");
  if (nl >= 0) t = t.slice(nl + 1);
  else t = t.slice(3); // drop the leading ``` when the fence is single-line
  const i = t.lastIndexOf("```");
  if (i >= 0) t = t.slice(0, i);
  return t;
}
