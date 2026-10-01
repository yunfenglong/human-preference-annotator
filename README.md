# Human Preference Annotator

A web tool for collecting side-by-side driving-video preference annotations. The production target is one Cloudflare Worker:

- Worker static assets serve `frontend/`.
- Worker routes under `/api/*` replace Express.
- D1 replaces MongoDB and the writable `tokens.json` file.
- R2 stores the MP4 files; `/videos/*` streams them with HTTP byte-range support.

The old `backend/` and `render.yaml` remain as migration reference only. Production runs from `worker/index.js`.

## Cloudflare binding contract

The Worker expects these exact bindings and secrets:

| Name | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 database | Tokens, annotator progress, repeat queues, and annotations |
| `VIDEOS` | R2 bucket | Objects keyed exactly like `videos/early_late_mi_training/...mp4` |
| `ASSETS` | Worker assets | Configured automatically from `frontend/` |
| `ADMIN_PASSWORD` | Secret | Password entered in `/admin/` |
| `ADMIN_TOKEN` | Secret | Long random admin session token |
| `CORS_ORIGIN` | Optional variable | Comma-separated extra frontend origins |

Cloudflare's products are named **D1** and **R2**. If “D2/R1” was used in discussion, confirm that it means these two services.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Open `http://localhost:8787/?token=ffb981fe` for the seeded annotator or `http://localhost:8787/admin/` for the admin dashboard. Local D1 and R2 data live under the ignored `.wrangler/` directory.

`seed.local.sql` contains the three tokens previously committed in `backend/data/tokens.json`. It is deliberately not a migration, so those public development tokens are not inserted into production.

## One-time Cloudflare setup

Your teammate can create the resources or bind existing ones. Keep the binding names `DB` and `VIDEOS` even if the resource names differ.

```bash
npx wrangler login
npx wrangler d1 create human-preference-annotator
npx wrangler r2 bucket create human-preference-videos
```

Copy the returned D1 database ID into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`. If the R2 bucket has a different name, update `bucket_name` but not the `VIDEOS` binding.

Set production secrets without committing their values:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_TOKEN
```

Apply the schema, upload videos, and deploy:

```bash
npm run db:migrate:remote
./scripts/upload_videos_to_r2.sh human-preference-videos feae999
npm run deploy
```

The upload script recovers all 227 MP4s (about 123 MiB) from Git commit `feae999` and uploads them under the exact `videos/...` keys used by the catalogues. It does not restore the files into the working tree.

## CI deployment

`.github/workflows/pages.yml` now deploys the Worker manually instead of publishing the obsolete GitHub Pages frontend. Add these GitHub repository secrets, then run **Deploy Cloudflare Worker** from the GitHub Actions page:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The API token needs scoped access to Workers, D1, and R2. CI applies D1 migrations before deploying.

## Verification

Before handing over or deploying, run:

```bash
npm run check
```

After deployment, verify:

```bash
curl https://YOUR-WORKER.workers.dev/healthz
curl 'https://YOUR-WORKER.workers.dev/api/clip-pairs?token=YOUR_ANNOTATOR_TOKEN'
curl -sS -D - -o /dev/null -H 'Range: bytes=0-99' \
  'https://YOUR-WORKER.workers.dev/videos/gold/ego_video.mp4'
```

The video request should return `206 Partial Content`. The admin dashboard can then generate fresh annotator links and export all annotations as JSON.

## Existing MongoDB data

The D1 migrations create a new empty annotation store; they do not import an existing MongoDB deployment. If the Render/MongoDB instance contains study data that must be retained, export it before cutover and transform it into the D1 tables before directing users to the Worker.
