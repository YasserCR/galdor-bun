/**
 * core/spellbook — galdor's prompt registry: versioned prompt templates,
 * retrievable by name and version.
 *
 * A {@link Spell} is one versioned prompt template. A {@link Book} is a registry
 * of spells, available as an in-memory implementation ({@link newBook}) and a
 * file-backed one ({@link openBook}) that reads `dir/<name>/<version>.md`. The
 * registry uses themed naming ("spell", "book"); the constructors stay unthemed
 * so application code can adopt them without buying into the theme.
 *
 * Templating model — IMPORTANT: {@link render} deliberately performs a SIMPLE
 * single-pass token substitution rather than implementing a full templating
 * engine. It replaces `{{key}}`, `{{ key }}` and `{{.key}}` with
 * `String(data[key])`. There are no pipelines, functions, conditionals, ranges,
 * or nested field paths. An unknown key throws rather than rendering an empty
 * string, so a typo'd template fails loudly. Anything that is not a bare
 * `{{ identifier }}` token is left verbatim.
 *
 * @example
 * ```ts
 * const book = newBook(
 *   { name: "greet", version: "v1", template: "Hello {{name}}" },
 * );
 * render(book.latest("greet"), { name: "Ada" }); // "Hello Ada"
 * ```
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Error raised by {@link Book} lookups ({@link Book.get}, {@link Book.latest})
 * when the requested spell or version does not exist in the registry.
 */
export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/**
 * One versioned prompt template.
 *
 * @property name - Identifier of the prompt family this version belongs to.
 * @property version - Opaque version label, compared as a string (see {@link Book}).
 * @property template - Raw template text with optional `{{ token }}` placeholders.
 * @property metadata - Optional free-form labels. Only the in-memory book carries
 * these; the file-backed book does not persist or load them.
 */
export interface Spell {
  name: string;
  version: string;
  template: string;
  /** Free-form labels. Only the in-memory book carries these; the file book omits them. */
  metadata?: Record<string, string>;
}

/** Data supplied to {@link render}; keys are looked up by template token name. */
export type TemplateData = Record<string, unknown>;

/**
 * Matches a single substitution token: `{{ name }}`, `{{name}}`, or `{{.name}}`.
 * The optional leading dot is accepted as a convenience for templates that
 * prefix field names with a dot; the captured key is the identifier without it.
 */
const TOKEN = /\{\{\s*\.?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Render a spell's template against `data` using simple token substitution.
 *
 * Replaces each `{{key}}` / `{{ key }}` / `{{.key}}` token with
 * `String(data[key])`. Text with no tokens is returned verbatim. See the module
 * doc for the templating model and its intentional limitations.
 *
 * @param spell - The spell whose `template` is rendered.
 * @param data - Lookup table mapping token names to values; each value is coerced
 * with `String(...)`. Defaults to an empty object.
 * @returns The template with every token replaced by its stringified value.
 * @throws Error if a token references a key absent from `data`.
 * @example
 * ```ts
 * render({ name: "t", version: "v1", template: "Hi {{name}}" }, { name: "Ada" });
 * // "Hi Ada"
 * ```
 */
export function render(spell: Spell, data: TemplateData = {}): string {
  return spell.template.replace(TOKEN, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      throw new Error(`spellbook: render ${JSON.stringify(spell.name)}: missing key ${JSON.stringify(key)}`);
    }
    return String(data[key]);
  });
}

/**
 * A registry of spells.
 *
 * `get` fetches a specific `(name, version)`. `latest` returns the
 * lexically-greatest version of a name — version strings are opaque labels, so
 * "latest" means greatest under string ordering (use zero-padded or
 * date-prefixed versions if you need a particular order). `list` returns every
 * spell, sorted by `(name, version)`. Lookups throw {@link NotFoundError} when a
 * spell or version is missing.
 */
export interface Book {
  /**
   * Fetch the spell registered under an exact `(name, version)` pair.
   * @throws NotFoundError if no such spell exists.
   */
  get(name: string, version: string): Spell;
  /**
   * Fetch the lexically-greatest version registered for `name`.
   * @throws NotFoundError if `name` has no registered versions.
   */
  latest(name: string): Spell;
  /** List every spell, sorted ascending by `(name, version)`. */
  list(): Spell[];
}

/** Byte-order string comparison; orders ASCII labels by code point. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortSpells(spells: Spell[]): void {
  spells.sort((x, y) => cmp(x.name, y.name) || cmp(x.version, y.version));
}

function key(name: string, version: string): string {
  return `${name}\x00${version}`;
}

/**
 * Build an in-memory {@link Book} holding the given spells.
 *
 * @param spells - The spells to register. If two share a `(name, version)`, the
 * later one wins.
 * @returns A {@link Book} backed entirely by memory; it preserves each spell's
 * {@link Spell.metadata}.
 * @example
 * ```ts
 * const book = newBook(
 *   { name: "greet", version: "v1", template: "Hi {{name}}" },
 *   { name: "greet", version: "v2", template: "Hello {{name}}" },
 * );
 * book.latest("greet").version; // "v2"
 * ```
 */
export function newBook(...spells: Spell[]): Book {
  const byKey = new Map<string, Spell>();
  for (const s of spells) byKey.set(key(s.name, s.version), s);

  return {
    get(name, version) {
      const s = byKey.get(key(name, version));
      if (s === undefined) {
        throw new NotFoundError(`spellbook: spell not found: ${JSON.stringify(name)}@${JSON.stringify(version)}`);
      }
      return s;
    },
    latest(name) {
      const versions: string[] = [];
      for (const s of byKey.values()) {
        if (s.name === name) versions.push(s.version);
      }
      if (versions.length === 0) {
        throw new NotFoundError(`spellbook: spell not found: ${JSON.stringify(name)}`);
      }
      versions.sort(cmp);
      return this.get(name, versions[versions.length - 1]!);
    },
    list() {
      const out = [...byKey.values()];
      sortSpells(out);
      return out;
    },
  };
}

/** File extension for spell version files; the file content is the raw template. */
const SPELL_EXT = ".md";

/**
 * Rejects spell/version labels that could escape the store directory (path
 * separators, "..", NUL bytes, empty). The file store joins these into a path,
 * so they must be single, non-traversing segments.
 */
function safeName(s: string): void {
  if (s === "") {
    throw new Error("spellbook: name/version must not be empty");
  }
  if (s === "." || s === ".." || /[/\\\x00]/.test(s) || s.includes("..")) {
    throw new Error(
      `spellbook: invalid name/version ${JSON.stringify(s)} (no path separators, NUL, or '..')`,
    );
  }
}

function isNotExist(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Returns a file-backed {@link Book} rooted at `dir`. The layout is
 *
 *     dir/<name>/<version>.md
 *
 * where each file's content is the raw prompt template. Names and versions are
 * the directory and file names. The file backend does not store or load
 * {@link Spell.metadata}.
 *
 * @param dir - Root directory of the spell store.
 * @returns A {@link Book} that reads spells lazily from disk on each call.
 * @throws Error if `dir` does not exist or is not a directory.
 * @example
 * ```ts
 * const book = openBook("./prompts"); // reads ./prompts/<name>/<version>.md
 * book.get("summarize", "v1");
 * ```
 */
export function openBook(dir: string): Book {
  let info;
  try {
    info = statSync(dir);
  } catch (err) {
    throw new Error(`spellbook: open ${dir}: ${(err as Error).message}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`spellbook: ${dir} is not a directory`);
  }

  function versionsOf(name: string): string[] {
    safeName(name);
    let entries;
    try {
      entries = readdirSync(join(dir, name), { withFileTypes: true });
    } catch (err) {
      if (isNotExist(err)) return [];
      throw new Error(`spellbook: list ${JSON.stringify(name)}: ${(err as Error).message}`);
    }
    const versions: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() || !e.name.endsWith(SPELL_EXT)) continue;
      versions.push(e.name.slice(0, -SPELL_EXT.length));
    }
    return versions;
  }

  const book: Book = {
    get(name, version) {
      safeName(name);
      safeName(version);
      const path = join(dir, name, version + SPELL_EXT);
      let data: string;
      try {
        data = readFileSync(path, "utf8");
      } catch (err) {
        if (isNotExist(err)) {
          throw new NotFoundError(
            `spellbook: spell not found: ${JSON.stringify(name)}@${JSON.stringify(version)}`,
          );
        }
        throw new Error(`spellbook: read ${JSON.stringify(name)}@${JSON.stringify(version)}: ${(err as Error).message}`);
      }
      return { name, version, template: data };
    },
    latest(name) {
      const versions = versionsOf(name);
      if (versions.length === 0) {
        throw new NotFoundError(`spellbook: spell not found: ${JSON.stringify(name)}`);
      }
      versions.sort(cmp);
      return book.get(name, versions[versions.length - 1]!);
    },
    list() {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        throw new Error(`spellbook: list ${dir}: ${(err as Error).message}`);
      }
      const out: Spell[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        for (const v of versionsOf(e.name)) {
          out.push(book.get(e.name, v));
        }
      }
      sortSpells(out);
      return out;
    },
  };
  return book;
}
