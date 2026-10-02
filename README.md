# Human Preference Annotator

A web tool for collecting blind stereoscopic A/B judgments for pixelMorph’s SK3 preference pipeline. The current entry point is `/study.html` (also reached from `/?token=...`).

See [pixelMorph alignment and handoff](docs/pixelmorph-alignment.md) for verified task import, display requirements, response export and downstream DPO use. Before collection, import a real `TASKS.json` plus untouched `stimuli/`, agree the display protocol and question, and configure `SK_EXPORT_ID`. Collection stays disabled until that handoff is ready.

The previous driving study is available at `/?legacy=1&token=...`; its data and optional surprise/attention steps are kept separate. `/admin/` manages viewer links and legacy data, while `/admin/study.html` delivers SK3 responses.

The production target is one Cloudflare Worker:

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
| `SK_EXPORT_ID` | Variable | SHA-256 of verified SK3 `TASKS.json` |

Cloudflare's products are named **D1** and **R2**. If “D2/R1” was used in discussion, confirm that it means these two services.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

After importing the SK3 handoff, open `http://localhost:8787/?token=ffb981fe` for the seeded annotator or `http://localhost:8787/admin/` for the admin dashboard. Local D1 and R2 data live under the ignored `.wrangler/` directory.

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
./scripts/upload_videos_to_r2.sh /path/to/video-directory-or-archive.tar human-preference-videos
npm run deploy
```

The repository history intentionally contains no MP4 files. Obtain the video directory or tar archive separately, outside Git. The upload script accepts either source and uploads all MP4s under the exact `videos/...` keys used by the catalogues.

## CI deployment

`.github/workflows/pages.yml` now deploys the Worker manually instead of publishing the obsolete GitHub Pages frontend. Add these GitHub repository secrets, then run **Deploy Cloudflare Worker** from the GitHub Actions page:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The API token needs scoped access to Workers, D1, and R2. CI applies D1 migrations before deploying.

## Verification

### Extended-display playback and optional steps

Use desktop Chrome with displays in **Extend** mode. Open an annotator link,
choose the video screen, allow window-management permission, and open the video
window. Pop-ups must be allowed for this site. In the video window:

- `1` replays the Up clip; `2` replays the Down clip. Only one plays at a time.
- `ArrowUp` prefers Up; `ArrowDown` prefers Down; `C` selects Can't tell when enabled.
- In Surprise, `ArrowUp`/`ArrowDown` selects the more surprising clip; `N` selects neither.
- In Attention, `X` starts pause sampling. Click to mark points; Space/Enter
  continues, `Z` undoes a point, and `C` clears the current points.

Playback and annotation require native fullscreen. Exiting fullscreen pauses
both videos and blocks answers. Press the currently selected video's number
in the video window to reenter; an attention sample retains its time and marks.
Esc remains available to exit fullscreen. A missing second display, denied
permission, or unsupported browser does not fall back to windowed playback.

The admin dashboard's **Annotation Settings** controls Can't tell, Surprise,
and Attention independently. Settings persist in D1; disabled steps are skipped,
and disabled fields are excluded from saved answers. Changes apply when the
next pair loads or the annotator refreshes. All three features default to enabled.

Run fullscreen/state regression checks with `node --test tests/presentation.test.cjs`.
Hardware screen placement still needs verification on the intended dual-display setup.

Before handing over or deploying, run:

```bash
npm test
npm run check
```

After deployment, verify:

```bash
curl https://YOUR-WORKER.workers.dev/healthz
curl 'https://YOUR-WORKER.workers.dev/api/clip-pairs?token=YOUR_ANNOTATOR_TOKEN'
curl -sS -D - -o /dev/null -H 'Range: bytes=0-99' \
  'https://YOUR-WORKER.workers.dev/videos/gold/ego_video.mp4'
```

The video request should return `206 Partial Content`. The admin dashboard can then generate fresh pseudonymous viewer links. Use `/admin/study.html` to export SK3 responses and retain the cursor after each successful downstream import.

## Existing MongoDB data

The D1 migrations create a new empty annotation store; they do not import an existing MongoDB deployment. If the Render/MongoDB instance contains study data that must be retained, export it before cutover and transform it into the D1 tables before directing users to the Worker.
