import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleStudy } from '../worker/sk-labeling.js';

globalThis.crypto ||= webcrypto;
const batch = 'assigned_batch';
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = { schema: 'sk_labeling_task_export_v1', seed: 1, fixture: true,
  bundle: { question_id: 'fixture-comfort', display_sha256: 'd'.repeat(64), protocol_sha256: 'f'.repeat(64) }, task_count: 24,
  tasks: Array.from({ length: 24 }, (_, i) => {
    const id = i.toString(16).padStart(16, '0');
    return { task_id: id, clip_id: id, question_id: 'fixture-comfort',
      stimuli: Object.fromEntries(['A', 'B'].map(side => [side, { file: `stimuli/${id}_${side}_FSBS_LR.mp4`, sha256: hash('fixture') }])),
      video: { layout: 'side_by_side_left_right', eye_width: 640, eye_height: 128, frames: 24, fps: '24', duration_s: 1 } };
  }) };
const settings = { ...manifest.bundle, question: 'Which is more comfortable?', setup_instructions: 'Synthetic fixture', setup_confirmed: true, repeat_rate: 0.1 };
const csv = '\ufefftask_id,clip_id,viewer_id\r\n' + manifest.tasks.map((t, i) => `${t.task_id},${t.clip_id},${i < 13 ? 'R1' : 'R2'}`).join('\r\n') + '\r\n';
let env, runtime;
async function call(path, body, admin = true) {
  const response = await handleStudy(new Request(`https://local/api/${path}`, body ? { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), env, () => admin);
  return { status: response.status, body: await response.json() };
}
before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', d1Databases: ['DB'], r2Buckets: ['VIDEOS'] }));
  env = { DB: await runtime.getD1Database('DB'), VIDEOS: await runtime.getR2Bucket('VIDEOS') };
  for (const name of ['0001_initial.sql', '0002_sk_labeling.sql', '0004_study_batches.sql', '0005_viewer_groups.sql']) {
    const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    for (const sql of source.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  }
  await env.DB.prepare("INSERT INTO tokens(annotator_id, token) VALUES ('P017','viewer-one'), ('P042','viewer-two'), ('P099','unassigned')").run();
  await env.VIDEOS.put(`${batch}/TASKS.json`, JSON.stringify(manifest));
  await env.VIDEOS.put(`${batch}/RATER_ASSIGNMENT.csv`, csv);
  for (const t of manifest.tasks) for (const side of ['A', 'B']) await env.VIDEOS.put(`${batch}/${t.stimuli[side].file}`, 'fixture');
});
after(async () => runtime?.dispose());

test('dashboard can inspect groups and assign viewers before batch activation', async () => {
  const detail = await call(`admin/study/batch?batch=${batch}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.groups, [{ group_id: 'R1', task_count: 13 }, { group_id: 'R2', task_count: 11 }]);
  assert.equal((await call(`admin/study/viewers?batch=${batch}`, undefined, false)).status, 403);
  assert.equal((await call('admin/study/viewer-group', { batch, viewer_id: 'P017', group_id: 'R1' }, false)).status, 403);
  assert.equal((await call('admin/study/viewer-group', { batch, viewer_id: 'missing', group_id: 'R1' })).status, 400);
  assert.equal((await call('admin/study/viewer-group', { batch, viewer_id: 'P017', group_id: 'missing' })).status, 400);
  assert.equal((await call('admin/study/viewer-group', { batch, viewer_id: 'P017', group_id: 'R1' })).status, 200);
  assert.equal((await call('admin/study/viewer-group', { batch, viewer_id: 'P042', group_id: 'R2' })).status, 200);
  const viewers = await call(`admin/study/viewers?batch=${batch}`);
  assert.equal(viewers.status, 200);
  assert.equal(viewers.body.viewers.find(v => v.viewer_id === 'P017').total, 13);
  assert.equal(viewers.body.viewers.find(v => v.viewer_id === 'P042').total, 11);
  assert.equal(viewers.body.viewers.find(v => v.viewer_id === 'P099').total, 0);
  assert.equal((await call('admin/study/activate', { batch, settings })).status, 200);
});
test('viewer creation saves group atomically and rejects unknown groups without generating a token', async () => {
  assert.equal((await call('admin/study/viewer', { batch, viewer_id: 'P100', group_id: 'unknown' })).status, 400);
  assert.equal(await env.DB.prepare("SELECT token FROM tokens WHERE annotator_id = 'P100'").first(), null);
  const created = await call('admin/study/viewer', { batch, viewer_id: 'P100', group_id: 'R2' });
  assert.equal(created.status, 200); assert.ok(created.body.token); assert.equal(created.body.group_id, 'R2');
  assert.equal((await call('admin/study/viewer', { batch, viewer_id: 'P100', group_id: 'R2' })).status, 409);
});
test('unassigned viewer cannot enroll; group is frozen once a session starts', async () => {
  const missing = await call('study/session', { token: 'unassigned' });
  assert.equal(missing.status, 403); assert.match(missing.body.error, /group/i);
  assert.equal(await env.DB.prepare("SELECT * FROM sk_sessions WHERE viewer_id = 'P099'").first(), null);
  assert.equal((await call('study/session', { token: 'viewer-one' })).status, 200);
  assert.equal((await call('admin/study/viewer-group', { batch, viewer_id: 'P017', group_id: 'R2' })).status, 409);
  assert.equal((await call('admin/study/viewer-group', { batch, viewer_id: 'P017', group_id: 'R1' })).status, 200);
});
test('next, reload, repeats and progress use only assigned tasks; response viewer IDs stay personal', async () => {
  const sessionId = (await call('study/session', { token: 'viewer-one' })).body.session_id;
  const session = { token: 'viewer-one', session_id: sessionId };
  const allowed = new Set(manifest.tasks.slice(0,13).map(t => t.task_id));
  for (let i = 0; i < 20; i++) {
    const next = await call('study/next', session); assert.equal(next.status, 200);
    if (!next.body) break;
    assert.equal(next.body.progress.total, 13);
    assert.ok(allowed.has(next.body.task.task_id), 'out-of-group task was served');
    assert.equal((await call('study/next', session)).body.trial_id, next.body.trial_id);
    assert.equal((await call('study/respond', { ...session, trial_id: next.body.trial_id, choice: 'A', playback_complete: true })).status, 200);
  }
  assert.equal((await call('study/next', session)).body, null);
  const answers = (await call('admin/study/export')).body.responses;
  assert.equal(answers.filter(r => !r.repeat).length, 13);
  assert.equal(answers.filter(r => r.repeat).length, 1);
  assert.ok(answers.every(r => r.viewer_id === 'P017' && allowed.has(r.task)));
  const viewers = (await call(`admin/study/viewers?batch=${batch}`)).body.viewers;
  const p = viewers.find(v => v.viewer_id === 'P017');
  assert.equal(p.completed, 13); assert.equal(p.total, 13); assert.equal(p.repeats, 1); assert.equal(p.group_id, 'R1'); assert.equal(p.enrolled, true);
  const secondSession = (await call('study/session', { token: 'viewer-two' })).body.session_id;
  const second = await call('study/next', { token: 'viewer-two', session_id: secondSession });
  assert.equal(second.body.progress.total, 11);
  assert.ok(!allowed.has(second.body.task.task_id));
});
test('an invalid or changed assignment never falls back to the full batch', async () => {
  await env.VIDEOS.put(`${batch}/RATER_ASSIGNMENT.csv`, csv.replace('R1','R2'));
  const changed = await call('study/config');
  assert.equal(changed.status, 503); assert.match(changed.body.error, /assignment.*changed/i);
  await env.VIDEOS.put(`${batch}/RATER_ASSIGNMENT.csv`, csv);
  assert.equal((await call('study/config')).status, 200);
  const invalidBatch = 'invalid_assignment';
  await env.VIDEOS.put(`${invalidBatch}/TASKS.json`, JSON.stringify(manifest));
  await env.VIDEOS.put(`${invalidBatch}/RATER_ASSIGNMENT.csv`, 'task_id,clip_id,viewer_id\nunknown,unknown,R1\n');
  assert.equal((await call(`admin/study/batch?batch=${invalidBatch}`)).status, 400);
});
test('pre-group sessions without answers can receive their first group; old pending trials are invalidated', async () => {
  const oldBatch = 'pre_group_batch', oldManifest = { ...manifest, seed: 2 };
  await env.VIDEOS.put(`${oldBatch}/TASKS.json`, JSON.stringify(oldManifest));
  for (const task of manifest.tasks) for (const side of ['A', 'B']) await env.VIDEOS.put(`${oldBatch}/${task.stimuli[side].file}`, 'fixture');
  await env.DB.prepare("INSERT INTO tokens(annotator_id,token) VALUES ('P200','pre-group-token')").run();
  assert.equal((await call('admin/study/activate', { batch: oldBatch, settings })).status, 200);
  const sessionId = (await call('study/session', { token: 'pre-group-token' })).body.session_id;
  const session = { token: 'pre-group-token', session_id: sessionId };
  const oldTrial = (await call('study/next', session)).body;
  assert.equal(oldTrial.progress.total, 24);
  await env.VIDEOS.put(`${oldBatch}/RATER_ASSIGNMENT.csv`, csv);
  assert.equal((await call('admin/study/activate', { batch: oldBatch, settings })).status, 200);
  const row = (await call(`admin/study/viewers?batch=${oldBatch}`)).body.viewers.find(v => v.viewer_id === 'P200');
  assert.equal(row.enrolled, true); assert.equal(row.group_locked, false);
  assert.equal((await call('study/respond', { ...session, trial_id: oldTrial.trial_id, choice: 'A', playback_complete: true })).status, 403);
  assert.equal((await call('admin/study/viewer-group', { batch: oldBatch, viewer_id: 'P200', group_id: 'R2' })).status, 200);
  const next = (await call('study/next', session)).body;
  assert.notEqual(next.trial_id, oldTrial.trial_id); assert.equal(next.progress.total, 11);
  assert.ok(manifest.tasks.slice(13).some(task => task.task_id === next.task.task_id));
  assert.equal((await call('study/respond', { ...session, trial_id: oldTrial.trial_id, choice: 'A', playback_complete: true })).status, 400);
  assert.equal((await call('admin/study/viewer-group', { batch: oldBatch, viewer_id: 'P200', group_id: 'R1' })).status, 409);
  assert.equal((await call('admin/study/export')).body.responses.length, 0);
});
