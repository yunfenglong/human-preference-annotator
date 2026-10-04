import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTasks, publicTask, validateChoice, responsePayload, orderedTasks } from '../shared/sk-contract.js';
import { inspectExport } from '../scripts/import_sk_tasks.mjs';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const task = { task_id: '0123456789abcdef', clip_id: 'abcdef0123456789', question_id: 'test-question',
  stimuli: Object.fromEntries(['A', 'B'].map(s => [s, { file: `stimuli/0123456789abcdef_${s}.mp4`, sha256: 'a'.repeat(64) }])),
  video: { layout: 'side_by_side_left_right', eye_width: 640, eye_height: 128, frames: 25, fps: '24', duration_s: 25 / 24 } };
const manifest = () => ({ schema: 'sk_labeling_task_export_v1', seed: 9, fixture: true,
  bundle: { question_id: 'test-question', display_sha256: 'd'.repeat(64), protocol_sha256: 'f'.repeat(64) }, task_count: 1, tasks: [structuredClone(task)] });

test('accepts rational frame rates and rejects malformed or unknown exports', () => {
  assert.equal(validateTasks(manifest()).task_count, 1);
  for (const mutate of [m => m.schema = 'v2', m => m.task_count = 2, m => m.tasks.push(m.tasks[0]),
    m => m.tasks[0].stimuli.A.file = '../PACKET.json', m => m.tasks[0].video.layout = 'mono',
    m => m.tasks[0].video.fps = '24/0', m => m.tasks[0].video.duration_s = 5,
    m => m.tasks[0].question_id = 'other']) {
    const m = manifest(); mutate(m); assert.throws(() => validateTasks(m));
  }
  const decimal = manifest(); decimal.tasks[0].video.fps = '24.0'; assert.doesNotThrow(() => validateTasks(decimal));
  const m = manifest(); m.tasks[0].video.fps = '24000/1001'; m.tasks[0].video.duration_s = 25 * 1001 / 24000;
  assert.doesNotThrow(() => validateTasks(m));
});
test('blind task serialization preserves A/B and removes private metadata', () => {
  const secret = structuredClone(task); secret.parameters = { action: 7 }; secret.video.source = 'source-path';
  const result = publicTask(secret, 'e'.repeat(64));
  assert.equal(result.stimuli.A.sha256, task.stimuli.A.sha256);
  assert.ok(result.stimuli.A.file.endsWith('_A.mp4'));
  assert.equal(result.parameters, undefined); assert.equal(result.video.source, undefined);
});
test('exported FSBS filenames are preserved, with traversal and wrong-side references rejected', () => {
  const m = manifest();
  for (const side of ['A', 'B']) m.tasks[0].stimuli[side].file = `stimuli/${task.task_id}_${side}_FSBS_LR.mp4`;
  assert.doesNotThrow(() => validateTasks(m));
  assert.equal(publicTask(m.tasks[0], 'preference_v1_clean_20261003').stimuli.A.file,
    `/videos/batches/preference_v1_clean_20261003/stimuli/${task.task_id}_A_FSBS_LR.mp4`);
  for (const file of [`stimuli/${task.task_id}_B_FSBS_LR.mp4`, `stimuli/../${task.task_id}_A.mp4`,
    `stimuli/${task.task_id}_A.mp4?other=1`, `stimuli/${task.task_id}_A/extra.mp4`]) {
    const invalid = structuredClone(m); invalid.tasks[0].stimuli.A.file = file;
    assert.throws(() => validateTasks(invalid), /unexpected stimulus path/);
  }
});
test('incomplete preferences rejected; uncertainty and technical failure are retained', () => {
  for (const choice of ['A', 'B', 'tie']) { assert.throws(() => validateChoice(choice, false)); assert.doesNotThrow(() => validateChoice(choice, true)); }
  for (const choice of ['uncertain', 'technical_failure']) assert.doesNotThrow(() => validateChoice(choice, false));
  for (const value of ['true', 1, null]) assert.throws(() => validateChoice('A', value));
  assert.throws(() => validateChoice('cant_tell', true));
});
test('export has exactly eight fields and actual JSON booleans', () => {
  const payload = responsePayload([{ response_id: 'uuid', task: task.task_id, viewer_id: 'P017', session_id: 'session', choice: 'B', playback_complete: 1, is_repeat: 0, timestamp: '2026-10-02T10:00:00Z', export_id: 'secret', sequence: 7 }]);
  assert.equal(payload.schema, 'sk_labeling_responses_v1');
  assert.deepEqual(Object.keys(payload.responses[0]).sort(), ['response_id', 'task', 'viewer_id', 'session_id', 'choice', 'playback_complete', 'repeat', 'timestamp'].sort());
  assert.equal(payload.responses[0].playback_complete, true); assert.equal(payload.responses[0].repeat, false);
});
test('viewer task shuffle is stable and never changes stimulus order', () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({ ...task, task_id: i.toString(16).padStart(16, '0') }));
  assert.deepEqual(orderedTasks(tasks, 'P017'), orderedTasks(tasks, 'P017'));
  assert.deepEqual(tasks.map(t => t.stimuli), orderedTasks(tasks, 'P017').map(t => t.stimuli));
});
test('handoff checksum failure stops before upload / decoding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-contract-'));
  try {
    const m = manifest(); await mkdir(join(root, 'stimuli'));
    await writeFile(join(root, 'TASKS.json'), JSON.stringify(m));
    await writeFile(join(root, task.stimuli.A.file), 'corrupt mp4');
    await writeFile(join(root, 'STUDY.json'), JSON.stringify({ ...m.bundle, question: 'Question?', setup_confirmed: true, setup_instructions: 'Test display', repeat_rate: 0.1 }));
    await assert.rejects(inspectExport(root, join(root, 'STUDY.json')), /SHA-256 mismatch/);
  } finally { await rm(root, { recursive: true }); }
});
