import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Book, NotFoundError, newBook, openBook, render, type Spell } from "./index.ts";

describe("render", () => {
  test("substitutes {{ key }}, {{key}} and {{.key}} tokens", () => {
    const spell: Spell = { name: "t", version: "v1", template: "Summarize {{Topic}} in {{ N }} points." };
    expect(render(spell, { Topic: "Go", N: 3 })).toBe("Summarize Go in 3 points.");

    // The dotted token form `{{.Name}}` resolves to the same key as `{{Name}}`.
    const dotted: Spell = { name: "t", version: "v1", template: "Hi {{.Name}}" };
    expect(render(dotted, { Name: "Ada" })).toBe("Hi Ada");
  });

  test("template with no tokens is returned verbatim", () => {
    expect(render({ name: "t", version: "v1", template: "Bye" })).toBe("Bye");
  });

  test("a missing key throws loudly (Go missingkey=error parity)", () => {
    const spell: Spell = { name: "t", version: "v1", template: "Summarize {{Topic}} in {{N}} points." };
    expect(() => render(spell, { Topic: "Go" })).toThrow(/missing key/);
  });
});

describe("newBook (in-memory)", () => {
  const book = (): Book =>
    newBook(
      { name: "greet", version: "v1", template: "Hi {{.Name}}" },
      { name: "greet", version: "v2", template: "Hello {{.Name}}" },
      { name: "bye", version: "v1", template: "Bye" },
    );

  test("get fetches a specific (name, version)", () => {
    expect(book().get("greet", "v1").template).toBe("Hi {{.Name}}");
  });

  test("latest returns the lexically-greatest version", () => {
    expect(book().latest("greet").version).toBe("v2");
  });

  test("list is sorted by (name, version)", () => {
    const all = book().list();
    expect(all).toHaveLength(3);
    expect(all.map((s) => `${s.name}@${s.version}`)).toEqual(["bye@v1", "greet@v1", "greet@v2"]);
  });

  test("a later spell replaces an earlier one with the same key", () => {
    const b = newBook(
      { name: "x", version: "v1", template: "old" },
      { name: "x", version: "v1", template: "new" },
    );
    expect(b.get("x", "v1").template).toBe("new");
  });

  test("preserves metadata", () => {
    const b = newBook({ name: "x", version: "v1", template: "t", metadata: { author: "ada" } });
    expect(b.get("x", "v1").metadata).toEqual({ author: "ada" });
  });

  test("get/latest throw NotFoundError when missing", () => {
    const b = newBook();
    expect(() => b.get("nope", "v1")).toThrow(NotFoundError);
    expect(() => b.latest("nope")).toThrow(NotFoundError);
  });
});

describe("openBook (file-backed)", () => {
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "spellbook-"));
    dirs.push(d);
    return d;
  };
  const writeSpell = (dir: string, name: string, version: string, content: string): void => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${version}.md`), content);
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("round-trips spells through a temp dir", () => {
    const dir = mkTmp();
    writeSpell(dir, "summarize", "v1", "Summarize:\n{{.Input}}");
    writeSpell(dir, "summarize", "2024-06-01", "Summarize concisely:\n{{.Input}}");
    writeSpell(dir, "translate", "v1", "Translate to {{.Lang}}");

    const b = openBook(dir);

    expect(b.get("summarize", "v1").template).toStartWith("Summarize:");

    // Lexically greatest: "v1" > "2024-06-01".
    expect(b.latest("summarize").version).toBe("v1");

    const all = b.list();
    expect(all).toHaveLength(3);
    expect(all.map((s) => `${s.name}@${s.version}`)).toEqual([
      "summarize@2024-06-01",
      "summarize@v1",
      "translate@v1",
    ]);

    // A template loaded from disk renders identically to an in-memory one.
    expect(render(b.get("translate", "v1"), { Lang: "fr" })).toBe("Translate to fr");
  });

  test("get throws NotFoundError when the spell is missing", () => {
    const b = openBook(mkTmp());
    expect(() => b.get("ghost", "v1")).toThrow(NotFoundError);
  });

  test("openBook on a non-directory throws", () => {
    const dir = mkTmp();
    const f = join(dir, "afile");
    writeFileSync(f, "x");
    expect(() => openBook(f)).toThrow();
  });

  test("get rejects path traversal in name or version", () => {
    const b = openBook(mkTmp());
    for (const bad of ["../etc", "a/b", "..", "", "x\x00y"]) {
      expect(() => b.get(bad, "v1")).toThrow();
      expect(() => b.get("ok", bad)).toThrow();
    }
  });
});
