import { registerTrashRoutes } from "./workspace-trash.js";
import {
  listWorkspaceSources,
  readWorkspaceSource,
} from "./workspace-sources.js";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { zipSync } from "fflate";
import { openAssignment, prepareAssignment } from "./workspace-adapter.js";

const ID = /^[a-f0-9-]{36}$/;
const MAX_INPUT = 20 * 1024 * 1024;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateImport(content, taxonomy) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_INPUT) {
    throw bad("Choose a JSONL file smaller than 20 MB.");
  }
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length) throw bad("The file contains no documents.");
  const ids = new Set();
  return lines.map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw bad(`Line ${index + 1}: invalid JSON.`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw bad(`Line ${index + 1}: expected a document.`);
    const id = row.document_id;
    if (
      typeof id !== "string" ||
      !id.trim() ||
      /[/\\\x00-\x1f]/.test(id) ||
      [".", ".."].includes(id) ||
      id === "__proto__"
    ) {
      throw bad(
        `Line ${index + 1}: document_id must be a non-empty identifier without slashes or control characters.`,
      );
    }
    if (ids.has(id)) throw bad(`Duplicate document_id: ${id}.`);
    ids.add(id);
    if (typeof row.text !== "string" || !Array.isArray(row.spans))
      throw bad(`${id}: expected text and a spans array.`);
    if (
      ["annotations", "doc_id", "plain_text"].some((key) =>
        Object.hasOwn(row, key),
      )
    )
      throw bad(`${id}: use canonical document_id, text and spans fields.`);
    const chars = Array.from(row.text);
    for (const span of row.spans) {
      if (!span || !taxonomy.entity_labels.includes(span.label))
        throw bad(`${id}: unsupported span label.`);
      if (
        !Number.isInteger(span.begin) ||
        !Number.isInteger(span.end) ||
        span.begin < 0 ||
        span.end <= span.begin ||
        span.end > chars.length
      )
        throw bad(`${id}: span offsets are outside the document.`);
      if (
        span.text != null &&
        span.text !== chars.slice(span.begin, span.end).join("")
      )
        throw bad(`${id}: span text does not match its offsets.`);
    }
    return row;
  });
}

async function collectFiles(dir, prefix = "") {
  const files = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (
      entry.isSymbolicLink() ||
      entry.name.startsWith(".") ||
      entry.name.endsWith(".tmp")
    )
      continue;
    // Previous exports and migration backups are not part of the current result.
    if (
      ["exports", "profile-migrations", "rebase-backups"].includes(entry.name)
    )
      continue;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      Object.assign(
        files,
        await collectFiles(path.join(dir, entry.name), `${name}/`),
      );
    else files[name] = await fs.readFile(path.join(dir, entry.name));
  }
  return files;
}

export async function createWorkspaceRouter({
  rootDir,
  kind,
  workspaceDir = process.env.MEDDEID_WORKSPACE_DIR ||
    path.join(rootDir, "data", "workspaces"),
}) {
  const storageRoot = path.resolve(workspaceDir, kind);
  await fs.mkdir(storageRoot, { recursive: true });
  const taxonomy = JSON.parse(
    await fs.readFile(path.join(rootDir, "contracts/taxonomy.json"), "utf8"),
  );
  const app = express.Router();
  const contexts = new Map();

  async function context(id) {
    if (!ID.test(id)) throw bad("Assignment not found.", 404);
    if (!contexts.has(id)) {
      const pending = (async () => {
        const dir = path.join(storageRoot, id);
        let meta;
        try {
          meta = JSON.parse(
            await fs.readFile(path.join(dir, "assignment.json"), "utf8"),
          );
        } catch {
          throw bad("Assignment not found.", 404);
        }
        const opened = await openAssignment({
          rootDir,
          dataDir: path.join(dir, "work"),
        });
        return { ...opened, meta, dir, queue: Promise.resolve() };
      })();
      contexts.set(id, pending);
      pending.catch(() => contexts.delete(id));
    }
    return contexts.get(id);
  }
  // Each assignment has an independent queue. Reads and exports see complete saves;
  // a second browser tab cannot redirect a request to another assignment.
  async function exclusive(ctx, operation) {
    const guarded = () => {
      if (ctx.removed)
        throw bad(
          "This item was moved to trash. Return to the workspace library.",
          410,
        );
      return operation();
    };
    const result = ctx.queue.then(guarded, guarded);
    ctx.queue = result.catch(() => {});
    return result;
  }
  async function summary(ctx) {
    const payload = await ctx.getStore().getBootstrap();
    const count =
      kind === "annotate"
        ? payload.documents.length
        : payload.progress.texts.total;
    const total = kind === "annotate" ? count : payload.progress.spans.total;
    const reviewed =
      kind === "annotate"
        ? payload.documents.filter((doc) => doc.annotated === true).length
        : payload.progress.spans.confirmed;
    const languages = [
      ...new Set(
        (payload.documents || [])
          .map((doc) => doc.metadata?.lang || doc.language)
          .filter(Boolean),
      ),
    ];
    const output = path.join(
      ctx.dir,
      "work",
      kind === "annotate" ? "annotations.jsonl" : "subannotations.jsonl",
    );
    const stat = await fs.stat(output).catch(() => null);
    return {
      ...ctx.meta,
      documents: count,
      total,
      reviewed,
      unit: kind === "annotate" ? "documents" : "spans",
      complete: reviewed === total,
      languages,
      updatedAt: stat?.mtime.toISOString() || ctx.meta.createdAt,
      storagePath: ctx.dir,
      outputPath: output,
    };
  }
  const endpoint = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  registerTrashRoutes({
    app,
    workspaceDir,
    kind: kind,
    context,
    exclusive,
    contexts,
  });

  app.get(
    "/workspace",
    endpoint(async (_req, res) => {
      const assignments = [];
      for (const entry of await fs.readdir(storageRoot, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || !ID.test(entry.name)) continue;
        try {
          const ctx = await context(entry.name);
          assignments.push(await exclusive(ctx, () => summary(ctx)));
        } catch (error) {
          if (error.statusCode !== 404)
            assignments.push({
              id: entry.name,
              name: entry.name,
              dataset: "Unavailable assignment",
              error: error.message,
            });
        }
      }
      assignments.sort((a, b) =>
        (b.updatedAt || "").localeCompare(a.updatedAt || ""),
      );
      res.set("Cache-Control", "no-store").json({
        mode: "workspace",
        kind,
        storagePath: storageRoot,
        assignments,
      });
    }),
  );

  app.get(
    "/workspace/sources",
    endpoint(async (_req, res) => {
      res
        .set("Cache-Control", "no-store")
        .json(await listWorkspaceSources(path.resolve(workspaceDir)));
    }),
  );

  app.post(
    "/workspace/import",
    endpoint(async (req, res) => {
      let { content, filename } = req.body || {};
      let sourceRef = null;
      if (req.body?.source) {
        if (kind !== "subannotate")
          throw bad("Workspace handoffs are intended for detailed review.");
        const snapshot = await readWorkspaceSource(
          path.resolve(workspaceDir),
          req.body.source,
        );
        content = snapshot.content.toString();
        sourceRef = snapshot.source;
        filename = `${snapshot.source.kind}-${snapshot.source.id}.jsonl`;
      }
      if (
        sourceRef?.split &&
        req.body?.split &&
        req.body.split.trim() !== sourceRef.split
      )
        throw bad("The assignment split must match its source.");
      const dataset = String(req.body?.dataset || "").trim();
      const name = String(req.body?.name || "").trim();
      if (!dataset || !name || dataset.length > 120 || name.length > 120)
        throw bad(
          "Enter a dataset and assignment name (up to 120 characters each).",
        );
      const rows = validateImport(content, taxonomy);
      const normalized = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
      const id = crypto.randomUUID();
      const dir = path.join(storageRoot, id);
      const dataDir = path.join(dir, "work");
      await fs.mkdir(dataDir, { recursive: true });
      try {
        const sourcePath = path.join(dir, "source.jsonl");
        await fs.writeFile(sourcePath, normalized, { flag: "wx" });
        await prepareAssignment({ rootDir, dataDir, sourcePath });
        const opened = await openAssignment({ rootDir, dataDir });
        const meta = {
          id,
          dataset,
          name,
          sourceFilename: path.basename(
            String(filename || "annotations.jsonl"),
          ),
          createdAt: new Date().toISOString(),
          sourceSha256: hash(normalized),
          split: String(req.body?.split || sourceRef?.split || "")
            .trim()
            .slice(0, 80),
          ...(sourceRef ? { inputSource: sourceRef } : {}),
          kind,
        };
        await fs.writeFile(path.join(dir, "assignment.json"), jsonBytes(meta), {
          flag: "wx",
        });
        const ctx = { ...opened, meta, dir, queue: Promise.resolve() };
        contexts.set(id, Promise.resolve(ctx));
        res.status(201).json({ assignment: await summary(ctx) });
      } catch (error) {
        await fs.rm(dir, { recursive: true, force: true });
        throw bad(error.message);
      }
    }),
  );

  app.use(
    "/assignments/:assignmentId",
    endpoint(async (req, res, next) => {
      const ctx = await context(req.params.assignmentId);
      await exclusive(ctx, async () => {
        if (req.method === "GET" && req.path === "/details") {
          res.json({ assignment: await summary(ctx) });
          return;
        }
        if (req.method === "POST" && req.path === "/export") {
          const info = await summary(ctx);
          if (kind === "subannotate" && info.complete)
            await ctx.getStore().exportEvaluationBundle();
          const files = await collectFiles(path.join(ctx.dir, "work"), "work/");
          if (kind === "subannotate" && !info.complete) {
            for (const filename of Object.keys(files)) {
              if (filename.startsWith("work/evaluation-bundle/"))
                delete files[filename];
            }
          }
          files["source.jsonl"] = await fs.readFile(
            path.join(ctx.dir, "source.jsonl"),
          );
          files["annotations.jsonl"] = await fs.readFile(
            path.join(ctx.dir, "work", "annotations.jsonl"),
          );
          if (kind === "annotate" && info.complete) {
            const rows = validateImport(
              files["annotations.jsonl"].toString(),
              taxonomy,
            );
            files["annotations.manifest.json"] = jsonBytes({
              manifest_version: "meddeid.annotation-set.v1",
              annotation_set_id: ctx.meta.id,
              status: "completed",
              contracts: {
                schema_version: "meddeid.schema.v1",
                offset_unit: "unicode_codepoints",
                taxonomy_contract_version: taxonomy.contract_version,
                taxonomy_version: taxonomy.taxonomy_version,
              },
              files: { annotations: "annotations.jsonl" },
              hashes: { annotations_sha256: hash(files["annotations.jsonl"]) },
              counts: {
                documents: rows.length,
                spans: rows.reduce((n, row) => n + row.spans.length, 0),
              },
            });
          }
          const manifest = {
            manifest_version: "meddeid.workspace-export.v1",
            kind,
            dataset: ctx.meta.dataset,
            assignment: ctx.meta.name,
            assignment_id: ctx.meta.id,
            status: info.complete ? "completed" : "in_progress",
            exported_at: new Date().toISOString(),
            progress: {
              reviewed: info.reviewed,
              total: info.total,
              unit: info.unit,
            },
            hashes: Object.fromEntries(
              Object.entries(files).map(([name, data]) => [name, hash(data)]),
            ),
          };
          files["workspace-manifest.json"] = jsonBytes(manifest);
          files["README.txt"] = Buffer.from(
            `MedDeID ${kind}: ${ctx.meta.dataset} / ${ctx.meta.name}\nStatus: ${manifest.status}\n\nsource.jsonl: original imported records.\nannotations.jsonl: ${kind === "annotate" ? "current reviewed working copy" : "primary annotations used for detailed review"}.\nwork/: current working files and saved review state.\n${info.complete ? (kind === "annotate" ? "annotations.manifest.json: completed annotation set, suitable for curation.\n" : "work/evaluation-bundle/: completed benchmark and its manifest.\n") : "This is a work-in-progress snapshot, not a completed reviewed dataset.\n"}workspace-manifest.json: provenance, progress and file checksums.\n`,
          );
          const exportedAt = new Date().toISOString().replace(/[:.]/g, "-");
          const basename = `${kind}-${ctx.meta.id.slice(0, 8)}-${exportedAt}.zip`;
          const exportDir = path.join(ctx.dir, "exports");
          await fs.mkdir(exportDir, { recursive: true });
          const bytes = Buffer.from(zipSync(files, { level: 6 }));
          await fs.writeFile(path.join(exportDir, basename), bytes, {
            flag: "wx",
          });
          res
            .set({
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="${basename}"`,
            })
            .send(bytes);
          return;
        }
        await new Promise((resolve, reject) => {
          res.once("finish", resolve);
          res.once("close", resolve);
          ctx.router(req, res, (error) => {
            if (error) reject(error);
            else {
              res.status(404).json({ error: "Unknown assignment action." });
              resolve();
            }
          });
        });
      });
    }),
  );
  app.use((error, _req, res, _next) => {
    if (!res.headersSent)
      res.status(error.statusCode || 500).json({ error: error.message });
  });
  return app;
}
