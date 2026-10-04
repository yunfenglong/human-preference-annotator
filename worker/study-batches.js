import { validateTasks } from '../shared/sk-contract.js';
import { parseRaterAssignment } from '../shared/rater-assignment.js';

export const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
export const validBatch = batch => typeof batch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(batch) && !batch.includes('..');

export async function activeBatch(env) {
  return env.DB.prepare('SELECT b.* FROM sk_batches b JOIN sk_active_batch a ON a.batch = b.batch WHERE a.id = 1').first();
}

async function manifestAt(env, batch, expectedId) {
  if (!validBatch(batch)) throw new Error('Choose a valid batch directory from the bucket root');
  const object = await env.VIDEOS.get(`${batch}/TASKS.json`);
  if (!object) throw new Error(`TASKS.json missing in batch ${batch}`);
  const bytes = await object.arrayBuffer();
  const exportId = await sha256(bytes);
  if (expectedId && expectedId !== exportId) throw new Error('TASKS.json identity mismatch. Use a new batch for a changed export.');
  return { manifest: validateTasks(JSON.parse(new TextDecoder().decode(bytes))), exportId };
}

async function assignmentAt(env, batch, manifest, expectedHash) {
  const object = await env.VIDEOS.get(`${batch}/RATER_ASSIGNMENT.csv`);
  if (!object) {
    if (expectedHash) throw new Error('RATER_ASSIGNMENT.csv changed or is missing');
    return null;
  }
  const bytes = await object.arrayBuffer();
  const hash = await sha256(bytes);
  if (expectedHash && hash !== expectedHash) throw new Error('RATER_ASSIGNMENT.csv changed. Publish a new batch for a changed assignment.');
  return { ...parseRaterAssignment(new TextDecoder().decode(bytes), manifest), hash };
}

export async function readBatch(env, batch) {
  if (!validBatch(batch)) throw new Error('Choose a valid batch directory from the bucket root');
  const registered = await env.DB.prepare('SELECT * FROM sk_batches WHERE batch = ?1').bind(batch).first();
  const { manifest, exportId } = await manifestAt(env, batch, registered?.export_id);
  const assignment = await assignmentAt(env, batch, manifest, registered?.assignment_sha256);
  return { batch, registered, manifest, exportId, assignment };
}

export function validateSettings(settings, manifest) {
  if (!settings || settings.question_id !== manifest.bundle.question_id ||
      settings.display_sha256 !== manifest.bundle.display_sha256 || settings.protocol_sha256 !== manifest.bundle.protocol_sha256 ||
      typeof settings.question !== 'string' || !settings.question.trim() || settings.setup_confirmed !== true ||
      typeof settings.setup_instructions !== 'string' || !settings.setup_instructions.trim()) {
    throw new Error('Question and display protocol must be explicitly agreed for this batch');
  }
  if (typeof settings.repeat_rate !== 'number' || !Number.isFinite(settings.repeat_rate) || settings.repeat_rate < 0 || settings.repeat_rate > 0.5) {
    throw new Error('repeat_rate must be between 0 and 0.5');
  }
}

async function checkFrozen(env, exportId, settingsHash) {
  const frozen = await env.DB.prepare('SELECT settings_sha256 FROM sk_exports WHERE export_id = ?1').bind(exportId).first();
  if (frozen && frozen.settings_sha256 !== settingsHash) throw new Error('Viewing settings changed after enrollment. Restore them or obtain a new export.');
}

export async function loadStudy(env, batch) {
  const registered = batch
    ? await env.DB.prepare('SELECT * FROM sk_batches WHERE batch = ?1').bind(batch).first()
    : await activeBatch(env);
  if (!registered) throw new Error(batch ? 'Batch has not been configured' : 'No active batch. Ask the admin to select a batch.');
  const { manifest, exportId } = await manifestAt(env, registered.batch, registered.export_id);
  const assignment = await assignmentAt(env, registered.batch, manifest, registered.assignment_sha256);
  if (assignment && !registered.assignment_sha256) throw new Error('Viewer assignment requires activation in the dashboard before collection');
  const settings = JSON.parse(registered.settings_json);
  validateSettings(settings, manifest);
  const settingsHash = await sha256(new TextEncoder().encode(registered.settings_json));
  await checkFrozen(env, exportId, settingsHash);
  return { manifest, settings, settingsHash, exportId, batch: registered.batch, assignment };
}

export async function listBatches(env, cursor) {
  const [page, selected, registered] = await Promise.all([
    env.VIDEOS.list({ delimiter: '/', limit: 100, ...(cursor ? { cursor } : {}) }),
    activeBatch(env), env.DB.prepare('SELECT batch FROM sk_batches').all(),
  ]);
  const configured = new Set(registered.results.map(row => row.batch));
  return {
    active_batch: selected?.batch ?? null,
    batches: page.delimitedPrefixes.map(prefix => prefix.replace(/\/$/, '')).filter(validBatch).sort().map(batch => ({
      batch, configured: configured.has(batch), active: batch === selected?.batch,
    })), cursor: page.truncated ? page.cursor : null,
  };
}

export async function inspectBatch(env, batch) {
  const { registered, manifest, exportId, assignment } = await readBatch(env, batch);
  let settings = registered ? JSON.parse(registered.settings_json) : null;
  if (!settings) {
    const object = await env.VIDEOS.get(`${batch}/STUDY.json`);
    if (object) settings = JSON.parse(await object.text());
  }
  return { batch, export_id: exportId, seed: manifest.seed, fixture: manifest.fixture, task_count: manifest.task_count,
    bundle: manifest.bundle, settings, groups: assignment?.summary ?? [], assignment_sha256: assignment?.hash ?? null,
    configured: Boolean(registered), viewing_instructions: manifest.viewing?.instructions ?? '',
    display_description: manifest.display_profile?.description ?? '' };
}

export async function activateBatch(env, batch, settings) {
  const { registered, manifest, exportId, assignment } = await readBatch(env, batch);
  const assignmentHash = assignment?.hash ?? null;
  if (registered && registered.assignment_sha256 !== assignmentHash &&
      await env.DB.prepare('SELECT id FROM sk_sessions WHERE export_id = ?1 LIMIT 1').bind(exportId).first() &&
      (registered.assignment_sha256 || await env.DB.prepare('SELECT sequence FROM sk_responses WHERE export_id = ?1 LIMIT 1').bind(exportId).first())) {
    throw new Error('Viewer assignment cannot change after enrollment. Use a new export.');
  }
  validateSettings(settings, manifest);
  const settingsJson = JSON.stringify(settings);
  const settingsHash = await sha256(new TextEncoder().encode(settingsJson));
  await checkFrozen(env, exportId, settingsHash);
  // Inspect the existing keys, without copying or renaming any upstream video.
  const files = new Set();
  let cursor;
  do {
    const page = await env.VIDEOS.list({ prefix: `${batch}/stimuli/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) if (object.size > 0) files.add(object.key);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  for (const task of manifest.tasks) for (const side of ['A', 'B']) {
    if (!files.has(`${batch}/${task.stimuli[side].file}`)) throw new Error(`Stimulus file missing or empty: ${task.stimuli[side].file}`);
  }
  // The conditional upsert also protects against enrollment racing a settings edit.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sk_batches(batch, export_id, settings_json, assignment_sha256)
      SELECT ?1, ?2, ?3, ?5 WHERE NOT EXISTS (SELECT 1 FROM sk_exports WHERE export_id = ?2 AND settings_sha256 != ?4)
      ON CONFLICT(batch) DO UPDATE SET settings_json = excluded.settings_json, assignment_sha256 = excluded.assignment_sha256
      WHERE sk_batches.assignment_sha256 IS excluded.assignment_sha256
      OR NOT EXISTS (SELECT 1 FROM sk_sessions WHERE export_id = ?2)
      OR (sk_batches.assignment_sha256 IS NULL AND NOT EXISTS (SELECT 1 FROM sk_responses WHERE export_id = ?2))`)
      .bind(batch, exportId, settingsJson, settingsHash, assignmentHash),
    env.DB.prepare(`INSERT INTO sk_active_batch(id, batch)
      SELECT 1, batch FROM sk_batches WHERE batch = ?1 AND export_id = ?2 AND settings_json = ?3
      ON CONFLICT(id) DO UPDATE SET batch = excluded.batch`).bind(batch, exportId, settingsJson),
  ]);
  const active = await loadStudy(env);
  if (active.batch !== batch || active.settingsHash !== settingsHash) throw new Error('Batch settings changed during activation; reload and try again');
  return { batch, export_id: exportId, seed: manifest.seed, fixture: manifest.fixture, task_count: manifest.task_count };
}
