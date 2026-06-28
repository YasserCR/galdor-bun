/**
 * core/eval — dataset loading, saving, and validation.
 *
 * Datasets are stored as plain JSON whose shape is exactly the {@link Dataset}
 * interface, so files round-trip without any conversion step.
 */

import { type Dataset, EvalError } from "./types.ts";

/** True when running under the Bun runtime; false under Node (and elsewhere). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Reads a UTF-8 file and parses it as JSON, using Bun's fast file API when
 * available and falling back to `node:fs/promises` on every other runtime.
 */
async function readJsonFile(path: string): Promise<unknown> {
  if (isBun) return Bun.file(path).json();
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Writes `text` to `path` (UTF-8), using `Bun.write` under Bun and
 * `node:fs/promises` `writeFile` on every other runtime.
 */
async function writeTextFile(path: string, text: string): Promise<void> {
  if (isBun) {
    await Bun.write(path, text);
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, text, "utf8");
}

/**
 * Reads and validates a JSON dataset from disk.
 *
 * @param path - Filesystem path to a JSON file shaped like {@link Dataset}.
 * @returns The parsed, validated dataset.
 * @throws {EvalError} If the file cannot be read/parsed, or fails
 * {@link validateDataset} (missing name/version, empty or duplicate-id cases).
 * @example
 * ```ts
 * const ds = await loadDataset("./datasets/capitals.json");
 * console.log(ds.cases.length);
 * ```
 */
export async function loadDataset(path: string): Promise<Dataset> {
  let d: Dataset;
  try {
    d = (await readJsonFile(path)) as Dataset;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new EvalError(`eval: read ${path}: ${msg}`);
  }
  try {
    validateDataset(d);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new EvalError(`eval: ${path}: ${msg}`);
  }
  return d;
}

/**
 * Validates `d` and writes it to `path` as indented JSON. Handy when a dataset
 * is generated programmatically and persisted for future regression runs.
 *
 * @param d - The dataset to persist.
 * @param path - Destination file path.
 * @throws {EvalError} If `d` fails {@link validateDataset}.
 */
export async function saveDataset(d: Dataset, path: string): Promise<void> {
  validateDataset(d);
  await writeTextFile(path, JSON.stringify(d, null, 2));
}

/**
 * Asserts that `d` is a well-formed {@link Dataset}: an object with a non-empty
 * name and version, at least one case, and a non-empty unique id on every case.
 *
 * @param d - The candidate dataset.
 * @throws {EvalError} On the first structural problem encountered.
 */
export function validateDataset(d: Dataset): void {
  if (!d || typeof d !== "object") {
    throw new EvalError("Dataset is not an object");
  }
  if (!d.name) throw new EvalError("Dataset.name is empty");
  if (!d.version) throw new EvalError("Dataset.version is empty");
  if (!Array.isArray(d.cases) || d.cases.length === 0) {
    throw new EvalError("Dataset.cases is empty");
  }
  const seen = new Set<string>();
  for (let i = 0; i < d.cases.length; i++) {
    const c = d.cases[i]!;
    if (!c.id) throw new EvalError(`Cases[${i}].id is empty`);
    if (seen.has(c.id)) throw new EvalError(`duplicate Case.id ${JSON.stringify(c.id)}`);
    seen.add(c.id);
  }
}
