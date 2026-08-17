# meddeid-annotate

Local primary-span annotation for canonical MedDeID JSONL. A reviewer can edit
model pre-annotations or annotate from scratch, then save a completed assignment
for training or curation.

See [prepare and annotate data](https://meddeid.github.io/workflows/prepare-and-annotate/)
for the surrounding workflow. This repository remains authoritative for the
annotation application's setup, storage, and interaction contract.

Use `meddeid-curate` to reconcile independent annotation sets and
`meddeid-subannotate` to add core-PII character segments for evaluation.

## Run locally

Requirements: Node.js 20 or later and npm.

```bash
npm install
MEDDEID_ANNOTATIONS_PATH=/path/to/annotations.jsonl npm run dev
```

The development server binds to `127.0.0.1`. The configured JSONL file is the
current annotation state and is updated in place. It may begin with empty spans
or with predictions produced by `meddeid batch`; reviewers edit, delete, and add
spans through the same interface. A document remains unreviewed until saved.

## Input contract

Each row contains `document_id`, `text`, canonical `spans`, and optional
`metadata`. Offsets are half-open `[begin, end)` ranges measured in Unicode code
points. Labels and valid subtypes come from `contracts/taxonomy.json`.

Input validation is strict. Every record must use the canonical `document_id`,
`text`, and `spans` fields. Unsupported alternatives such as `doc_id`,
`annotations`, `Category`, and `Subtype` are rejected.

## Docker

The released container is the default route; no source checkout or Node.js
installation is required:

```bash
docker pull ghcr.io/stighellemans/meddeid-annotate:0.1.0
mkdir -p data
cp /path/to/annotations.jsonl data/annotations.jsonl
docker run --rm -p 127.0.0.1:8787:8787 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD/data:/app/data" \
  ghcr.io/stighellemans/meddeid-annotate:0.1.0
```

The container reads and writes `data/annotations.jsonl`. The application does
not provide authentication; keep it on localhost or place it behind an
authenticated TLS reverse proxy that meets your organization’s requirements.

To test an unreleased source change instead, run
`docker build -t meddeid-annotate .` and substitute that image name above.

## Development

```bash
npm test
npm run test:browser
```

Regenerate the JavaScript taxonomy contract after an intentional core-taxonomy
change with `npm run taxonomy:sync`.

## Licence

AGPL-3.0-only.
