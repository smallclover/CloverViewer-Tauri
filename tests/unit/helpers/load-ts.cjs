const { readFileSync } = require("node:fs");
const { resolve, dirname } = require("node:path");
const { createRequire } = require("node:module");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

module.exports = function loadTs(relative, overrides = {}, globals = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const nativeRequire = createRequire(file);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, {
      module, exports: module.exports, console, setTimeout, clearTimeout,
      require: name => Object.hasOwn(overrides, name) ? overrides[name]
        : name.startsWith(".") ? load(resolve(dirname(file), `${name}.ts`)) : nativeRequire(name),
      ...globals,
    }, { filename: file });
    return module.exports;
  }
  return load(resolve(__dirname, "../../../src", relative));
};
