import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { unzipSync } from "fflate";
import { createWorkspaceRouter } from "../server/workspace-router.js";
const kind = "annotate";
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const row = {
  document_id: "same-doc",
  text: "Alex Example",
  annotated: kind === "subannotate",
  spans: [{ begin: 0, end: 12, label: "Name:Patient" }],
};

async function serve(workspaceDir) {
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.use("/api", await createWorkspaceRouter({ rootDir, kind, workspaceDir }));
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return {
    async call(route, body, method) {
      return fetch(`${base}${route}`, {
        method: method || (body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
async function importAssignment(api, name, rows = [row]) {
  const response = await api.call("/workspace/import", {
    dataset: "Test dataset",
    name,
    filename: "notes.jsonl",
    content: rows.map((r) => JSON.stringify(r)).join("\n"),
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  return result.assignment;
}

test("workspace isolates identical document IDs, persists across restarts, and exports verified bundles", async () => {
  let workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `meddeid-${kind}-workspace-`),
  );
  let api = await serve(workspaceDir);
  try {
    assert.deepEqual(
      (await (await api.call("/workspace")).json()).assignments,
      [],
    );
    const a = await importAssignment(api, "Reviewer A");
    const b = await importAssignment(api, "Reviewer B");
    assert.notEqual(a.id, b.id);
    const first = await (
      await api.call(`/assignments/${a.id}/bootstrap`)
    ).json();
    let save;
    if (kind === "annotate") {
      save = await api.call(
        `/assignments/${a.id}/documents/same-doc`,
        {
          spans: [{ begin: 0, end: 12, label: "Name:Other" }],
          annotated: true,
        },
        "PUT",
      );
    } else {
      save = await api.call(`/assignments/${a.id}/items/save`, {
        itemId: first.items[0].itemId,
        status: "confirmed",
        segments: [
          { begin: 0, end: 4, category: "given" },
          { begin: 4, end: 5, category: "formatting" },
          { begin: 5, end: 12, category: "family" },
        ],
      });
    }
    assert.equal(save.status, 200, await save.text());
    const [aDetails, bDetails] = await Promise.all(
      [a, b].map(
        async (entry) =>
          (await (await api.call(`/assignments/${entry.id}/details`)).json())
            .assignment,
      ),
    );
    assert.equal(aDetails.reviewed, 1);
    assert.equal(bDetails.reviewed, 0);
    assert.equal(aDetails.complete, true);
    const source = JSON.parse(
      (
        await fs.readFile(path.join(a.storagePath, "source.jsonl"), "utf8")
      ).trim(),
    );
    assert.equal(source.spans[0].label, "Name:Patient");
    const draftExport = await api.call(
      `/assignments/${b.id}/export`,
      {},
      "POST",
    );
    assert.equal(draftExport.status, 200);
    const draftFiles = unzipSync(
      new Uint8Array(await draftExport.arrayBuffer()),
    );
    assert.equal(
      JSON.parse(Buffer.from(draftFiles["workspace-manifest.json"]).toString())
        .status,
      "in_progress",
    );
    assert.equal(draftFiles["annotations.manifest.json"], undefined);
    const completedExport = await api.call(
      `/assignments/${a.id}/export`,
      {},
      "POST",
    );
    assert.equal(completedExport.status, 200);
    const files = unzipSync(
      new Uint8Array(await completedExport.arrayBuffer()),
    );
    const manifest = JSON.parse(
      Buffer.from(files["workspace-manifest.json"]).toString(),
    );
    assert.equal(manifest.status, "completed");
    for (const [filename, expected] of Object.entries(manifest.hashes))
      assert.equal(digest(files[filename]), expected, filename);
    if (kind === "annotate") {
      const annotationManifest = JSON.parse(
        Buffer.from(files["annotations.manifest.json"]).toString(),
      );
      assert.equal(
        annotationManifest.contracts.offset_unit,
        "unicode_codepoints",
      );
      assert.equal(
        annotationManifest.hashes.annotations_sha256,
        digest(files["annotations.jsonl"]),
      );
    } else {
      assert.ok(files["work/evaluation-bundle/benchmark.jsonl"]);
      const benchmark = JSON.parse(
        Buffer.from(files["work/evaluation-bundle/benchmark.jsonl"])
          .toString()
          .trim(),
      );
      assert.equal(benchmark.spans[0].subannotations.length, 3);
    }
    assert.equal(
      (await fs.readdir(path.join(a.storagePath, "exports"))).length,
      1,
    );
    await api.close();
    // A workspace can move between host directories and Docker mount paths.
    await fs.rename(workspaceDir, `${workspaceDir}-moved`);
    workspaceDir = `${workspaceDir}-moved`;
    api = await serve(workspaceDir);
    const resumed = (
      await (await api.call(`/assignments/${a.id}/details`)).json()
    ).assignment;
    assert.equal(resumed.reviewed, 1);
    assert.equal(
      (await (await api.call(`/assignments/${b.id}/details`)).json()).assignment
        .reviewed,
      0,
    );
    if (kind === 'subannotate') {
      const rebase = await api.call(`/assignments/${a.id}/rebase/check`, {}, 'POST');
      assert.equal(rebase.status, 200);
      assert.equal((await rebase.json()).upToDate, true);
      const reopened = await api.call(`/assignments/${a.id}/items/save`, {
        itemId: first.items[0].itemId, status: 'in_progress',
        segments: [{ begin: 0, end: 12, category: 'given' }],
      });
      assert.equal(reopened.status, 200);
      const snapshot = await api.call(`/assignments/${a.id}/export`, {}, 'POST');
      assert.equal(snapshot.status, 200);
      const snapshotFiles = unzipSync(new Uint8Array(await snapshot.arrayBuffer()));
      assert.equal(snapshotFiles['work/evaluation-bundle/benchmark.jsonl'], undefined);
      assert.equal(JSON.parse(Buffer.from(snapshotFiles['workspace-manifest.json']).toString()).status, 'in_progress');
    }
    // Unknown or unscoped requests never fall back to another assignment.
    assert.equal(
      (
        await api.call(
          "/assignments/00000000-0000-0000-0000-000000000000/bootstrap",
        )
      ).status,
      404,
    );
    assert.equal((await api.call("/bootstrap")).status, 404);
  } finally {
    await api.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("invalid imports leave no assignments or partial work behind", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "meddeid-import-"),
  );
  const api = await serve(workspaceDir);
  try {
    const invalid = [
      "not JSON",
      "",
      [row, row].map((r) => JSON.stringify(r)).join("\n"),
      JSON.stringify({
        ...row,
        spans: [{ begin: 0, end: 900, label: "Name:Patient" }],
      }),
    ];
    if (kind === "subannotate")
      invalid.push(JSON.stringify({ ...row, annotated: false }));
    for (const content of invalid) {
      const response = await api.call("/workspace/import", {
        dataset: "Demo",
        name: "Bad import",
        filename: "bad.jsonl",
        content,
      });
      assert.equal(response.status, 400, content);
    }
    assert.deepEqual(
      (await (await api.call("/workspace")).json()).assignments,
      [],
    );
    assert.deepEqual(await fs.readdir(path.join(workspaceDir, kind)), []);
  } finally {
    await api.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
