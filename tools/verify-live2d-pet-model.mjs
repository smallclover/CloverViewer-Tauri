import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const modelRoot = resolve(process.argv[2] ?? "public/pet-model/clover-girl-2");
const modelPath = resolve(modelRoot, process.argv[3] ?? "clovergirl-2_v1.model3.json");
const missing = [];

try {
  await access(modelPath);
} catch {
  console.error(`Missing model definition: ${modelPath}`);
  process.exit(1);
}

const model = JSON.parse(await readFile(modelPath, "utf8"));
const references = model.FileReferences ?? {};
const motions = references.Motions ?? {};
const referencedFiles = [
  references.Moc,
  ...(references.Textures ?? []),
  references.DisplayInfo,
  references.Physics,
];

for (const entries of Object.values(motions)) {
  referencedFiles.push(...entries.map((entry) => entry.File));
}

for (const file of referencedFiles.filter(Boolean)) {
  try {
    await access(resolve(modelRoot, file));
  } catch {
    missing.push(file);
  }
}

if (missing.length > 0) {
  console.error(`Live2D pet package is incomplete: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Live2D pet package is complete: ${modelPath}`);
