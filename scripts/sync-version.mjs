import { readFile, writeFile } from "node:fs/promises";

const checkOnly = process.argv.includes("--check");

const files = {
  packageJson: new URL("../package.json", import.meta.url),
  packageLock: new URL("../package-lock.json", import.meta.url),
  cargoToml: new URL("../src-tauri/Cargo.toml", import.meta.url),
  cargoLock: new URL("../src-tauri/Cargo.lock", import.meta.url),
};

const packageInfo = JSON.parse(await readFile(files.packageJson, "utf8"));
const version = packageInfo.version;
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (typeof version !== "string" || !semver.test(version)) {
  throw new Error(`package.json version must be valid semver, got: ${String(version)}`);
}

function replaceExactly(content, pattern, label) {
  if (!pattern.test(content)) {
    throw new Error(`Could not find ${label} version field to synchronize.`);
  }
  return content.replace(pattern, `$1"${version}"`);
}

const targets = [
  {
    label: "package-lock root",
    url: files.packageLock,
    pattern: /^(\{\r?\n {2}"name": "[^"]+",\r?\n {2}"version": )"[^"]+"/,
  },
  {
    label: "package-lock workspace package",
    url: files.packageLock,
    pattern:
      /( {2}"packages": \{\r?\n {4}"": \{\r?\n {6}"name": "[^"]+",\r?\n {6}"version": )"[^"]+"/,
  },
  {
    label: "Cargo.toml package",
    url: files.cargoToml,
    pattern: /^(\[package\]\r?\nname = "[^"]+"\r?\nversion = )"[^"]+"/m,
  },
  {
    label: "Cargo.lock workspace package",
    url: files.cargoLock,
    pattern: /^(\[\[package\]\]\r?\nname = "cloverviewer-tauri"\r?\nversion = )"[^"]+"/m,
  },
];

const contents = new Map();
for (const target of targets) {
  const content = contents.get(target.url) ?? (await readFile(target.url, "utf8"));
  const updated = replaceExactly(content, target.pattern, target.label);
  contents.set(target.url, updated);
}

const pending = [];
for (const [url, updated] of contents) {
  const original = await readFile(url, "utf8");
  if (updated !== original) pending.push([url, updated]);
}

if (checkOnly) {
  if (pending.length > 0) {
    const labels = targets
      .filter((target) => pending.some(([url]) => url === target.url))
      .map((target) => target.label);
    throw new Error(
      `Version metadata is out of sync with package.json (${version}): ${labels.join(", ")}`,
    );
  }
  console.log(`Version metadata is in sync: ${version}`);
} else {
  for (const [url, updated] of pending) await writeFile(url, updated, "utf8");
  console.log(
    pending.length === 0
      ? `Version metadata already in sync: ${version}`
      : `Synchronized version metadata: ${version}`,
  );
}
