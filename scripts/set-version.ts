#!/usr/bin/env bun
/**
 * Set the version on every workspace package at once.
 *
 * The packages reference each other with `workspace:*`, which `bun pm pack`
 * rewrites to the concrete version at pack time — so they must all carry the
 * SAME version for the published tarballs to satisfy each other on install.
 *
 * Usage:  bun run version:set 0.1.0
 */
import { $ } from "bun";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error("usage: bun run version:set <x.y.z>  (e.g. 0.1.0 or 1.0.0-rc.1)");
  process.exit(64);
}

const root = join(import.meta.dir, "..");
for (const dir of readdirSync(join(root, "packages"))) {
  const path = join(root, "packages", dir, "package.json");
  if (!existsSync(path)) continue;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name} → ${version}`);
}

// `bun pm pack` rewrites each `workspace:*` to the depended-upon package's
// version as recorded in the lockfile. A plain `bun install` won't refresh that
// after only a version change, so regenerate the lockfile to keep the packed
// inter-dependencies in sync with the new version.
rmSync(join(root, "bun.lock"), { force: true });
await $`bun install`.cwd(root).quiet();
console.log("\nlockfile regenerated — ready to `bun run pack`");
