import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleStudy } from '../worker/sk-labeling.js';

globalThis.crypto ||= webcrypto;
let runtime, env;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { schema: 'sk_labeling_task_export_v1', seed: 9, fixture: true,
  bundle: { question_id: 'fixture-which-looks-better', display_sha256: 'd'.repeat(64), protocol_sha256: 'f'.repeat(64) }, task_count: 12,
  tasks: Array.from({ length: 12 }, (_, i) => {
    const id = hash(JSON.stringify({ pair: `fixture-pair-${i}`, seed: 9 })).slice(0, 16);
    return { task_id: id, clip_id: Math.floor(i / 2).toString(16).padStart(16, '0'), question_id: 'fixture-which-looks-better',
      stimuli: Object.fromEntries(['A', 'B'].map(s => [s, { file: `stimuli/${id}_${s}.mp4`, sha256: 'a'.repeat(64) }])),
      video: { layout: 'side_by_side_left_right', eye_width: 640, eye_height: 128, frames: 25, fps: '24', duration_s: 25 / 24 } };
  }) };
const call = async (path, body, admin = false) => {
  const request = new Request(`http://local/api/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const response = await handleStudy(request, env, () => admin);
  return { status: response.status, body: await response.json(), headers: response.headers };
};
before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("test"); } }', d1Databases: ['DB'], r2Buckets: ['VIDEOS'] }));
  env = { DB: await runtime.getD1Database('DB'), VIDEOS: await runtime.getR2Bucket('VIDEOS') };
  for (const name of ['0001_initial.sql', '0002_sk_labeling.sql']) {
    // D1 exec accepts a statement per line; prepare handles the full migration SQL.
    const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    for (const statement of source.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("INSERT INTO tokens(annotator_id, token) VALUES ('P017', 'test-token'), ('P042', 'other-token')").run();
  const bytes = JSON.stringify(manifest); env.SK_EXPORT_ID = hash(bytes);
  await env.VIDEOS.put(`videos/studies/${env.SK_EXPORT_ID}/TASKS.json`, bytes);
  await env.VIDEOS.put(`videos/studies/${env.SK_EXPORT_ID}/STUDY.json`, JSON.stringify({ ...manifest.bundle, question: 'Which looks better?', setup_instructions: 'Synthetic test display', setup_confirmed: true, repeat_rate: 0.1 }));
});
after(async () => runtime?.dispose());

test('unconfigured export fails closed and invalid token is rejected', async () => {
  const old = env.SK_EXPORT_ID; env.SK_EXPORT_ID = '';
  assert.equal((await call('study/config')).status, 503); env.SK_EXPORT_ID = old;
  assert.equal((await call('study/session', { token: 'unknown' })).status, 403);
  assert.equal((await call('admin/study/export')).status, 403);
});
test('complete lifecycle: reload, playback validation, retry, primary failure, spaced repeats, exact incremental payload', async () => {
  const first = await call('study/session', { token: 'test-token' }); assert.equal(first.status, 200);
  const session = { token: 'test-token', session_id: first.body.session_id };
  assert.equal((await call('study/session', { token: 'test-token' })).body.session_id, session.session_id);
  let trial = (await call('study/next', session)).body;
  assert.equal((await call('study/next', session)).body.trial_id, trial.trial_id);
  assert.equal((await call('study/respond', { ...session, trial_id: trial.trial_id, choice: 'A', playback_complete: false })).status, 400);
  assert.equal((await call('study/respond', { ...session, trial_id: trial.trial_id, choice: 'A', playback_complete: 'true' })).status, 400);
  assert.equal((await call('study/respond', { ...session, trial_id: trial.trial_id, choice: 'A', playback_complete: true, repeat: true })).status, 200);
  assert.equal((await call('study/respond', { ...session, trial_id: trial.trial_id, choice: 'A', playback_complete: true })).status, 200);
  assert.equal((await call('study/respond', { ...session, trial_id: trial.trial_id, choice: 'B', playback_complete: true })).status, 409);
  for (let i = 0; i < 30; i++) {
    const next = await call('study/next', session); assert.equal(next.status, 200); trial = next.body;
    if (!trial) break;
    assert.equal((await call('study/respond', { ...session, trial_id: trial.trial_id, choice: i === 0 ? 'technical_failure' : 'B', playback_complete: i !== 0 })).status, 200);
  }
  assert.equal((await call('study/next', session)).body, null);
  const exported = await call('admin/study/export', undefined, true); assert.equal(exported.status, 200);
  assert.equal(exported.body.schema, 'sk_labeling_responses_v1');
  if (process.env.SK_COMPAT_OUTPUT) await writeFile(process.env.SK_COMPAT_OUTPUT, JSON.stringify(exported.body));
  assert.equal(exported.body.responses.length, 13);
  assert.equal(exported.body.responses.filter(r => !r.repeat).length, 12);
  assert.equal(exported.body.responses.filter(r => r.repeat).length, 1);
  assert.ok(exported.body.responses.some(r => r.choice === 'technical_failure' && !r.playback_complete && !r.repeat));
  for (const row of exported.body.responses) {
    assert.equal(Object.keys(row).length, 8); assert.equal(typeof row.repeat, 'boolean'); assert.match(row.timestamp, /Z$/);
  }
  const repeatIndex = exported.body.responses.findIndex(r => r.repeat);
  const originalIndex = exported.body.responses.findIndex(r => r.task === exported.body.responses[repeatIndex].task);
  assert.ok(repeatIndex - originalIndex > 10);
  const cursor = exported.headers.get('x-export-cursor');
  assert.deepEqual((await call(`admin/study/export?after=${cursor}`, undefined, true)).body.responses, []);
  assert.equal((await call('admin/study/export?after=-1', undefined, true)).status, 400);
});
test('server binds sessions to viewers and rejects viewer reuse across exports', async () => {
  const s = (await call('study/session', { token: 'test-token' })).body.session_id;
  assert.equal((await call('study/next', { token: 'other-token', session_id: s })).status, 403);
  const old = env.SK_EXPORT_ID;
  const another = { ...manifest, seed: 10 }; const bytes = JSON.stringify(another); env.SK_EXPORT_ID = hash(bytes);
  await env.VIDEOS.put(`videos/studies/${env.SK_EXPORT_ID}/TASKS.json`, bytes);
  await env.VIDEOS.put(`videos/studies/${env.SK_EXPORT_ID}/STUDY.json`, JSON.stringify({ ...manifest.bundle, question: 'Which looks better?', setup_instructions: 'Test', setup_confirmed: true, repeat_rate: 0.1 }));
  assert.equal((await call('study/session', { token: 'test-token' })).status, 409); env.SK_EXPORT_ID = old;
});

test('viewing settings cannot change once a viewer enrolls', async () => {
  const key = `videos/studies/${env.SK_EXPORT_ID}/STUDY.json`;
  const original = await (await env.VIDEOS.get(key)).arrayBuffer();
  const settings = JSON.parse(new TextDecoder().decode(original)); settings.question = 'A changed question';
  await env.VIDEOS.put(key, JSON.stringify(settings));
  assert.equal((await call('study/config')).status, 503);
  await env.VIDEOS.put(key, original);
  assert.equal((await call('study/config')).status, 200);
});
