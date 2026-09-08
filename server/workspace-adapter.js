import fs from "node:fs/promises";
import path from "node:path";
import { createAnnotationStore } from "./annotation-store.js";
import { createAnnotationRouter } from "./annotation-router.js";
export async function prepareAssignment({ dataDir, sourcePath }) {
  await fs.copyFile(sourcePath, path.join(dataDir, "annotations.jsonl"));
}
export async function openAssignment({ rootDir, dataDir }) {
  const store = createAnnotationStore({
    rootDir,
    dataPath: path.join(dataDir, "annotations.jsonl"),
  });
  await store.load();
  return { router: createAnnotationRouter({ store }), getStore: () => store };
}
