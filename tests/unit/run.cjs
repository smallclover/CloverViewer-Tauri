const { readdirSync } = require("node:fs");
const { join } = require("node:path");

for (const file of readdirSync(__dirname).filter(name => name.endsWith(".test.cjs")).sort()) {
  require(join(__dirname, file));
}
