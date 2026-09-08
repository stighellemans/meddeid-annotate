import express from "express";

export function createAnnotationRouter({ store }) {
  const app = express.Router();
  app.get("/bootstrap", async (_req, res) => {
    try {
      res.json(await store.getBootstrap());
    } catch (error) {
      res.status(500).json({
        error: "Failed to load annotations",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.put("/documents/:documentId", async (req, res) => {
    try {
      if (!Array.isArray(req.body?.spans)) {
        return res.status(400).json({
          error: "Failed to save document",
          detail:
            "Request body must contain canonical spans; annotations is not accepted",
        });
      }
      const document = await store.saveDocument(
        req.params.documentId,
        req.body.spans,
        req.body ?? {},
      );
      res.json({ document });
    } catch (error) {
      res.status(error?.statusCode ?? 500).json({
        error: "Failed to save document",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/batch/relabel", async (req, res) => {
    try {
      res.json(await store.batchRelabel(req.body ?? {}));
    } catch (error) {
      res.status(error?.statusCode ?? 500).json({
        error: "Failed to batch relabel",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/tracking/reset", async (_req, res) => {
    try {
      res.json(await store.resetTracking());
    } catch (error) {
      res.status(error?.statusCode ?? 500).json({
        error: "Failed to reset tracking",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
}
