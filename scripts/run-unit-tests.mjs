import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const generatedRoot = resolve(root, ".unit-test-dist");
const output = resolve(generatedRoot, "compiled");

// 只清空编译器专用目录，保留同级的历史截图、探针和 screenshot-baseline-dist。
if (dirname(output) !== generatedRoot) throw new Error("Invalid unit compiler output directory");
rmSync(output, { recursive: true, force: true });
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
