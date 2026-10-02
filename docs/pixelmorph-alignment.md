# pixelMorph SK3 labeling alignment

Aligned against pixelMorph `code` commit `307a57c974357c306950433c4445eef29a5b4d7d`
(read on 2026-10-02):

- [Labeling platform contract](https://github.com/yunfenglong/pixelMorph/blob/307a57c974357c306950433c4445eef29a5b4d7d/docs/engineering/labeling-platform-contract.md)
- [Preference pipeline](https://github.com/yunfenglong/pixelMorph/blob/307a57c974357c306950433c4445eef29a5b4d7d/docs/engineering/preference-pipeline.md)
- [Actual payload reader](https://github.com/yunfenglong/pixelMorph/blob/307a57c974357c306950433c4445eef29a5b4d7d/src/pixelmorph/preferences/collection.py)

The engineering index identifies SK3 scene preferences as the current route.
Phase I-A/I-B are historical guides; they do not define this labeling UI.

## What changed

| Previous driving annotator | Current SK3 collection |
| --- | --- |
| Generated `clip_pairs.json`, semantic filenames | Upstream blind `TASKS.json` and opaque `stimuli/` |
| Up/Down or left/right preferences | A/B assignment exactly as exported |
| Driving behavior question | Explicitly agreed wording for bundle `question_id` |
| `cant_tell` | Distinct `tie`, `uncertain`, `technical_failure` |
| Surprise ratings and attention markers | One preference answer per task |
| Looping / optional full viewing | A first, then B, both complete for A/B/tie |
| Generic fullscreen video fit | Native encoded resolution, SBS eye order unchanged |
| Gold injection and client repeat metadata | No gold injection; server-assigned spaced repeats |
| Internal annotation JSON | Exact `sk_labeling_responses_v1` eight-field responses |

`/?token=...` opens the SK3 UI. `/?legacy=1&token=...` retains the existing
 driving study, its display window and its admin settings. Legacy data are never
converted or included in SK3 exports: their identities, question, stimulus
geometry and playback evidence do not satisfy the new contract.

## Operator handoff

pixelMorph operators run `export-tasks` and send **only** `TASKS.json`,
`stimuli/` and optionally `RESPONSES_TEMPLATE.json`. The private assignment,
release packet, source clips, renderer actions and split information stay with
pixelMorph. The importer uploads only the explicitly listed stimulus files and
manifest, never other files in the handoff directory. Do not run old conversion,
crop or clip-pair scripts on these stimuli.

Before collecting, agree question wording, display device and stereo mode,
glasses, distance, lighting, consent/eligibility, session length/breaks, number
of viewers, repeat rate and delivery process. Keep any personal identity mapping
outside this application. Create a pseudonymous viewer ID in `/admin/`; the
same person must retain that ID across sessions of this export. This application
refuses to use an ID already assigned to another export: ask pixelMorph before
reusing people across exports, because the same internal pair may have another
opaque ID. Creating a different ID for the same person does not remove that
restriction.

Write an operator-owned `STUDY.json` outside Git. Copy the three identity fields
from the real manifest; the text and confirmation must describe the agreed
setup, not an invented default:

```json
{
  "question_id": "COPY_FROM_TASKS_BUNDLE",
  "display_sha256": "COPY_FROM_TASKS_BUNDLE",
  "protocol_sha256": "COPY_FROM_TASKS_BUNDLE",
  "question": "AGREED_QUESTION_WORDING",
  "setup_instructions": "AGREED_DEVICE_GLASSES_DISTANCE_LIGHTING_AND_STEREO_MODE",
  "setup_confirmed": true,
  "repeat_rate": 0.1
}
```

Verify first (requires `ffprobe` in PATH), then upload byte-for-byte:

```bash
npm run study:import -- /path/to/export /path/to/STUDY.json --verify-only
npm run study:import -- /path/to/export /path/to/STUDY.json --local
# Or explicitly upload to the existing production R2 bucket:
npm run study:import -- /path/to/export /path/to/STUDY.json --remote
```

The uploader currently targets the repo's `human-preference-videos` bucket.
Every file's SHA-256, frame dimensions, decoded frame count and frame rate must
match. A wrong file stops before upload. A second hash check protects against
source changes between validation and upload. Uploaded keys are isolated as
`videos/studies/<export_id>/stimuli/<task>_A.mp4` and `_B.mp4`.

The command prints `SK_EXPORT_ID`, the SHA-256 of the original `TASKS.json` bytes.
Set it in `.dev.vars` for local use and in `wrangler.jsonc`'s `vars` for deployment.
The Worker verifies the manifest identity and requires matching settings;
unconfigured collection returns 503. Do not modify settings for an export after
collecting labels. A changed physical setup requires a new pixelMorph export.
The settings hash is frozen in D1 when the first viewer enrolls; changing it
blocks collection until the original settings are restored. The current app supports one active export at a time; finish its response
deliveries before changing `SK_EXPORT_ID`.

Apply the additive D1 migrations, seed local tokens if needed, then run:

```bash
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

For production, use the existing `db:migrate:remote` and `deploy` commands after
reviewing the configuration. No deployment or remote migration is performed by
the implementation task itself.

## Playback and trials

The controller opens a separate video window on the selected stereo screen.
Browsers without screen selection can move that window manually. The viewer
confirms the agreed setup. Each file is downloaded and hashed before decoding;
a failed hash prevents playback. The complete SBS frame is centered at one
encoded pixel per physical display pixel, preserving aspect, frame rate and
eye halves. A display too small for that frame is rejected, rather than scaling
or cropping. The device must already be in the correct SBS stereo mode: the
browser cannot certify glasses, eye routing, viewing distance or physical 3D
output. Check these on the actual target hardware before a real session.

B is locked until A ends. A/B/tie answers stay locked until both end in
fullscreen without seeking, a playback-rate change or an interruption. The
viewer can replay either after the initial A→B viewing. `uncertain` and
`technical_failure` can be submitted before complete playback. This matches
the upstream import rule, but the server necessarily relies on playback evidence
reported by the browser; it cannot prove physical stereo viewing.

Refresh recovers the same session and pending trial. A lost save response can be
retried without producing another judgment; a different answer to a saved trial
is rejected. The server assigns primary/repeat status and timestamps. The first
primary answer consumes the task even if it is a technical failure. Repeats are
scheduled at approximately the configured rate, with at least ten intervening
primary answers; small exports may contain no repeats. The server avoids
adjacent same-clip tasks when another clip is available. Viewer IDs are bound
to one export, and the primary uniqueness constraint spans sessions.

Fullscreen and media startup have deadlines and show a retry message. A file
download also times out rather than counting as complete playback. Closing or
reopening the video window or reloading the controller retains the pending trial.

## Delivery and downstream use

Open `/admin/study.html`, sign in with the existing admin credentials, and
download new responses. The download has only:

```json
{
  "schema": "sk_labeling_responses_v1",
  "responses": [{
    "response_id": "SERVER_TRIAL_UUID",
    "task": "OPAQUE_TASK_ID",
    "viewer_id": "P017",
    "session_id": "SERVER_SESSION_UUID",
    "choice": "A",
    "playback_complete": true,
    "repeat": false,
    "timestamp": "2026-10-02T10:00:00.000Z"
  }]
}
```

The filename identifies seed, export identity and the sequence cursor interval.
Exports contain at most 5,000 responses; continue from the returned cursor for
larger studies. In the dashboard, **confirm imported** only after pixelMorph
successfully imports that file. The cursor is stored in that browser; retain it
with the handoff records when using another browser or operator. Retrying an
unimported delivery uses the same starting cursor. A payload already imported
must never be sent again. No server-side data are deleted on export or receipt.
Legacy `/api/admin/export` and `/api/admin/flush` operate on legacy data only.

pixelMorph runs:

```bash
PYTHONPATH=src:. python -m pixelmorph.preferences.cli import-tasks \
  --input release/PACKET.json --artifact-root release \
  --assignment export1/ASSIGNMENT_PRIVATE.json \
  --responses responses_seed-N_EXPORT_after-0_through-CURSOR.json > labelled.json
```

For the next delivery, use the previous `labelled.json` as `--input` and write a
new output file (never redirect onto the same input path). Import is atomic:
one invalid entry rejects the whole payload. The private map resolves A/B to
internal candidates, so never re-randomize A/B here.

Non-repeat A/B preferences feed the train split of policy-only scene DPO.
Ties, uncertainty, technical failures and repeats remain in the packet but do
not train. Splits, leakage control, release authorization, DPO training and
held-out evaluation remain pixelMorph's responsibility; this annotator does not
infer or rewrite them. Fixture exports always produce test-only labels.

## Verification

`npm test` covers the manifest/payload contracts and runs real local D1/R2
bindings through Miniflare for reloads, duplicate saves, playback constraints,
primary failures, spaced repeats, stable viewer identity and incremental export.
`npm run check` bundles the Worker without deploying it. A browser fixture can
verify the UI and file hashing; only the agreed physical display can verify
stereoscopic presentation at native resolution.

Implementation verification on 2026-10-02: ten tests passed, Worker dry-run
bundling passed, and the pinned upstream `collection.read_task_responses`
accepted a generated 13-response payload including a primary technical failure
and a repeat. Browser verification covered file hashing, locked A/B/tie buttons
before playback and a saved technical-failure trial. Fullscreen completion and
physical stereo presentation still require the target-device acceptance check.
