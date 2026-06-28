#!/usr/bin/env bun
/**
 * Pack every publishable @galdor/* package into ./dist-tarballs as installable
 * npm tarballs (the same artifact `npm publish` would upload).
 *
 * `bun pm pack` rewrites each `workspace:*` dependency to the package's concrete
 * version and includes the built `dist` (per each package's `files`). The result
 * installs on Node and Bun alike via the conditional `exports` map.
 *
 * Run `bun run build` first (the root `pack` script does this for you), then:
 *   bun scripts/pack.ts
 */
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// `cli` is a binary tool and `examples` is private — neither is a library tarball.
const PUBLISHABLE = [
  "core",
  "provider-anthropic",
  "provider-openai",
  "provider-google",
  "provider-bedrock",
  "mcp",
  "a2a",
  "dashboard",
];

const root = join(import.meta.dir, "..");
const out = join(root, "dist-tarballs");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of PUBLISHABLE) {
  await $`bun pm pack --destination ${out}`.cwd(join(root, "packages", name)).quiet();
  console.log(`✓ @galdor/${name}`);
}
console.log(`\n${PUBLISHABLE.length} tarballs written to dist-tarballs/`);
