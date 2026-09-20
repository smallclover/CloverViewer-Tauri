const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "../..");
const mainSource = readFileSync(resolve(root, "src/main.ts"), "utf8");
const pageSource = readFileSync(resolve(root, "index.html"), "utf8");

test("updates are checked only from the explicit settings action", () => {
  assert.match(
    mainSource,
    /checkUpdateButton\.addEventListener\("click", \(\) => void checkForUpdate\(\)\)/,
  );
  assert.doesNotMatch(mainSource, /setTimeout\(\(\) => void checkForUpdate/);
});

test("update dialog provides release notes and a non-installing later choice", () => {
  assert.match(pageSource, /id="update-overlay"/);
  assert.match(pageSource, /id="update-notes"/);
  assert.match(pageSource, /id="update-later"/);
  assert.match(pageSource, /id="update-now"/);
  assert.match(mainSource, /updateLaterButton\.addEventListener\("click", \(\) => dismissUpdateDialog\(false\)\)/);
  assert.match(mainSource, /updateNowButton\.addEventListener\("click", \(\) => dismissUpdateDialog\(true\)\)/);
});
