import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".unit-test-dist");

mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "package.json"), '{"type":"commonjs"}\n');

execFileSync(
  process.execPath,
  [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.unit.json"],
  {
    cwd: root,
    stdio: "inherit",
  },
);

execFileSync(process.execPath, ["tests/unit/run.cjs"], {
  cwd: root,
  stdio: "inherit",
});
