import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleStudy } from '../worker/sk-labeling.js';
import { serveVideo } from '../worker/videos.js';

globalThis.crypto ||= webcrypto;
let runtime, env;
const batch = 'preference_v1_clean_20261003';
const taskId = '0123456789abcdef';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  schema: 'sk_labeling_task_export_v1', seed: 20261003, fixture: true,
  bundle: { question_id: 'fixture-comfort', display_sha256: 'd'.repeat(64), protocol_sha256: 'f'.repeat(64) },
  task_count: 1, tasks: [{ task_id: taskId, clip_id: 'abcdef0123456789', question_id: 'fixture-comfort',
    stimuli: Object.fromEntries(['A', 'B'].map(side => [side, {
      file: `stimuli/${taskId}_${side}_FSBS_LR.mp4`, sha256: hash(`video-${side}`),
    }])), video: { layout: 'side_by_side_left_right', eye_width: 1920, eye_height: 1080, frames: 144, fps: '24', duration_s: 6 } }],
};
const settings = { ...manifest.bundle, question: 'Which is more comfortable?', setup_instructions: 'Agreed RayNeo setup', setup_confirmed: true, repeat_rate: 0.1 };
async function call(path, body, admin = true) {
  const response = await handleStudy(new Request(`https://local/api/${path}`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {}), env, () => admin);
  return { status: response.status, body: await response.json() };
}
before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', d1Databases: ['DB'], r2Buckets: ['VIDEOS'] }));
  env = { DB: await runtime.getD1Database('DB'), VIDEOS: await runtime.getR2Bucket('VIDEOS') };
  for (const name of ['0001_initial.sql', '0002_sk_labeling.sql', '0004_study_batches.sql', '0005_viewer_groups.sql']) {
    const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    for (const sql of source.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  }
  await env.DB.prepare("INSERT INTO tokens(annotator_id, token) VALUES ('P017', 'test-token'), ('P042', 'other-token')").run();
  await env.VIDEOS.put(`${batch}/TASKS.json`, JSON.stringify(manifest));
  for (const side of ['A', 'B']) await env.VIDEOS.put(`${batch}/${manifest.tasks[0].stimuli[side].file}`, `video-${side}`);
  await env.VIDEOS.put('incomplete/TASKS.json', JSON.stringify(manifest));
});
after(async () => runtime?.dispose());

test('admin discovers root batches before a study is configured; selection requires authentication', async () => {
  assert.equal((await call('study/config')).status, 503);
  assert.equal((await call('admin/study/batches', undefined, false)).status, 403);
  assert.equal((await call('admin/study/activate', { batch, settings }, false)).status, 403);
  const result = await call('admin/study/batches');
  assert.equal(result.status, 200);
  assert.ok(result.body.batches.some(item => item.batch === batch));
  const detail = await call(`admin/study/batch?batch=${batch}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task_count, 1);
  assert.equal(detail.body.settings, null);
});
test('selection validates settings, names and all stimulus keys before activating', async () => {
  for (const invalid of ['../secret', 'foo/bar', 'a?b', '', 'a..b']) {
    assert.equal((await call('admin/study/activate', { batch: invalid, settings })).status, 400);
  }
  assert.equal((await call('admin/study/activate', { batch, settings: { ...settings, setup_confirmed: false } })).status, 400);
  const incomplete = await call('admin/study/activate', { batch: 'incomplete', settings });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error, /stimulus.*missing/i);
  assert.equal((await call('study/config')).status, 503);
});
test('root batch media route streams the exact R2 key and preserves legacy byte ranges', async () => {
  const file = manifest.tasks[0].stimuli.A.file;
  const url = `https://local/videos/batches/${batch}/${file}`;
  const response = await serveVideo(new Request(url, { headers: { Range: 'bytes=0-3' } }), env);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/7');
  assert.equal(await response.text(), 'vide');
  const head = await serveVideo(new Request(url, { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '7');
  assert.equal(await head.text(), '');
  assert.equal((await serveVideo(new Request(`https://local/videos/batches/${batch}/TASKS.json`), env)).status, 400);
  await env.VIDEOS.put('videos/gold/ego_video.mp4', 'legacy');
  const legacy = await serveVideo(new Request('https://local/videos/gold/ego_video.mp4', { headers: { Range: 'bytes=0-2' } }), env);
  assert.equal(legacy.status, 206);
  assert.equal(await legacy.text(), 'leg');
});
test('batch discovery passes R2 pagination cursors, including pages containing only directories', async () => {
  const calls = [];
  const paginatedEnv = { ...env, VIDEOS: { list: async options => {
    calls.push(options);
    return options.cursor ? { objects: [], delimitedPrefixes: ['second/'], truncated: false }
      : { objects: [], delimitedPrefixes: [`${batch}/`], truncated: true, cursor: 'next-page' };
  } } };
  const get = async query => {
    const response = await handleStudy(new Request(`https://local/api/admin/study/batches${query}`), paginatedEnv, () => true);
    return response.json();
  };
  const first = await get('');
  assert.equal(first.cursor, 'next-page');
  const second = await get(`?cursor=${first.cursor}`);
  assert.equal(second.batches[0].batch, 'second');
  assert.equal(second.cursor, null);
  assert.equal(calls[1].cursor, 'next-page');
  assert.equal(calls[0].delimiter, '/');
});
test('root batch activation drives real sessions, suffixed media keys, responses and survives env reload', async () => {
  const activated = await call('admin/study/activate', { batch, settings });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.export_id, hash(JSON.stringify(manifest)));
  env = { DB: env.DB, VIDEOS: env.VIDEOS }; // no SK_EXPORT_ID / Worker variable
  const config = await call('study/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.batch, batch);
  const session = await call('study/session', { token: 'test-token' });
  const next = await call('study/next', { token: 'test-token', session_id: session.body.session_id });
  assert.equal(next.status, 200);
  assert.equal(next.body.task.stimuli.A.file, `/videos/batches/${batch}/stimuli/${taskId}_A_FSBS_LR.mp4`);
  const saved = await call('study/respond', { token: 'test-token', session_id: session.body.session_id, trial_id: next.body.trial_id, choice: 'A', playback_complete: true });
  assert.equal(saved.status, 200);
  const exported = await call('admin/study/export');
  assert.equal(exported.body.responses.length, 1);
  const changed = await call('admin/study/activate', { batch, settings: { ...settings, question: 'Changed question' } });
  assert.equal(changed.status, 400);
  assert.match(changed.body.error, /settings changed/i);
  assert.equal((await call('study/config')).body.question, settings.question);
});
test('batch switching isolates exports, preserves prior deliveries and rejects stale sessions', async () => {
  const anotherBatch = 'next_batch';
  const another = { ...manifest, seed: 20261004 };
  await env.VIDEOS.put(`${anotherBatch}/TASKS.json`, JSON.stringify(another));
  for (const side of ['A', 'B']) await env.VIDEOS.put(`${anotherBatch}/${manifest.tasks[0].stimuli[side].file}`, `video-${side}`);
  const oldSession = (await call('study/session', { token: 'test-token' })).body.session_id;
  assert.equal((await call('admin/study/activate', { batch: anotherBatch, settings })).status, 200);
  assert.equal((await call('study/config')).body.batch, anotherBatch);
  assert.equal((await call('study/next', { token: 'test-token', session_id: oldSession })).status, 403);
  assert.equal((await call('study/session', { token: 'test-token' })).status, 409);
  assert.equal((await call('admin/study/export')).body.responses.length, 0);
  assert.equal((await call(`admin/study/export?batch=${batch}`)).body.responses.length, 1);
  // A replaced manifest must not silently mix identities under a registered batch.
  await env.VIDEOS.put(`${anotherBatch}/TASKS.json`, JSON.stringify({ ...another, seed: 10 }));
  const changed = await call('study/config');
  assert.equal(changed.status, 503);
  assert.match(changed.body.error, /identity mismatch/i);
});
