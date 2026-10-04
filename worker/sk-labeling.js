import { publicTask, validateChoice, responsePayload, orderedTasks } from '../shared/sk-contract.js';
import { loadStudy, listBatches, inspectBatch, activateBatch } from './study-batches.js';
import { assignedTasks, studyViewers, setViewerGroup, createStudyViewer } from './viewer-groups.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const fail = (message, status = 400) => json({ error: message }, status);
const all = async statement => (await statement.all()).results;

async function viewer(env, token) {
  if (typeof token !== 'string' || !token) return null;
  return env.DB.prepare('SELECT annotator_id FROM tokens WHERE token = ?1').bind(token).first();
}

async function session(env, token, id, exportId) {
  if (typeof id !== "string" || !id.trim()) return null;
  const person = await viewer(env, token);
  if (!person) return null;
  return env.DB.prepare('SELECT * FROM sk_sessions WHERE id = ?1 AND viewer_id = ?2 AND export_id = ?3')
    .bind(id, person.annotator_id, exportId).first();
}

function trialResult(trial, tasks, batch, completed) {
  const task = tasks.find(t => t.task_id === trial.task_id);
  return { trial_id: trial.id, task: publicTask(task, batch), progress: { completed, total: tasks.length } };
}

export async function handleStudy(request, env, isAdmin) {
  const url = new URL(request.url);
  const path = url.pathname;
  let body;
  if (request.method === "POST") {
    try { body = await request.json(); } catch { return fail("A JSON object is required"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("A JSON object is required");
  }
  if (path === '/api/study/config' && request.method === 'GET') {
    try {
      const { manifest, settings, exportId, batch } = await loadStudy(env);
      return json({ batch, export_id: exportId, seed: manifest.seed, fixture: manifest.fixture, question: settings.question,
        setup_instructions: settings.setup_instructions, bundle: manifest.bundle });
    } catch (error) { return fail(error.message, 503); }
  }
  if (path.startsWith('/api/admin/study/') && !isAdmin(request, env)) return fail('Forbidden', 403);
  // These controls must work even when no batch has been activated yet.
  try {
    if (path === '/api/admin/study/batches' && request.method === 'GET') return json(await listBatches(env, url.searchParams.get('cursor')));
    if (path === '/api/admin/study/batch' && request.method === 'GET') return json(await inspectBatch(env, url.searchParams.get('batch')));
    if (path === '/api/admin/study/activate' && request.method === 'POST') return json(await activateBatch(env, body.batch, body.settings));
    if (path === '/api/admin/study/viewers' && request.method === 'GET') return json(await studyViewers(env, url.searchParams.get('batch')));
    if (path === '/api/admin/study/viewer-group' && request.method === 'POST') return json(await setViewerGroup(env, body.batch, body.viewer_id, body.group_id));
    if (path === '/api/admin/study/viewer' && request.method === 'POST') return json(await createStudyViewer(env, body.batch, body.viewer_id, body.group_id));
  } catch (error) { return fail(error.message, error.status || 400); }
  let active;
  try { active = await loadStudy(env, path.startsWith('/api/admin/study/') ? url.searchParams.get('batch') : null); } catch (error) { return fail(error.message, 503); }
  const { manifest, exportId, batch } = active;

  if (path === '/api/admin/study/export' && request.method === 'GET') {
    const afterText = url.searchParams.get('after') || '0';
    if (!/^\d+$/.test(afterText) || !Number.isSafeInteger(Number(afterText))) return fail('after must be a nonnegative integer');
    const rows = await all(env.DB.prepare('SELECT * FROM sk_responses WHERE export_id = ?1 AND sequence > ?2 ORDER BY sequence LIMIT 5000')
      .bind(exportId, Number(afterText)));
    const cursor = rows.at(-1)?.sequence ?? Number(afterText);
    return json(responsePayload(rows), 200, {
      'x-export-cursor': String(cursor), 'x-export-id': exportId,
      'content-disposition': `attachment; filename="responses_seed-${manifest.seed}_${exportId.slice(0, 12)}_after-${afterText}_through-${cursor}.json"`,
    });
  }
  if (path === '/api/admin/study/progress' && request.method === 'GET') {
    return json(await all(env.DB.prepare(`SELECT viewer_id, SUM(CASE WHEN is_repeat = 0 THEN 1 ELSE 0 END) AS completed,
      SUM(is_repeat) AS repeats, COUNT(*) AS responses FROM sk_responses WHERE export_id = ?1 GROUP BY viewer_id`).bind(exportId)));
  }
  if (path === '/api/study/session' && request.method === 'POST') {
    const person = await viewer(env, body.token);
    if (!person) return fail('Invalid token', 403);
    const viewerId = person.annotator_id;
    try { await assignedTasks(env, active, viewerId); } catch (error) { return fail(error.message, 403); }
    await env.DB.prepare("INSERT OR IGNORE INTO sk_exports(export_id, settings_sha256) VALUES (?1, ?2)").bind(exportId, active.settingsHash).run();
    const frozen = await env.DB.prepare("SELECT settings_sha256 FROM sk_exports WHERE export_id = ?1").bind(exportId).first();
    if (frozen.settings_sha256 !== active.settingsHash) return fail("Viewing settings changed during enrollment", 409);
    await env.DB.prepare('INSERT OR IGNORE INTO sk_viewers(viewer_id, export_id) VALUES (?1, ?2)').bind(viewerId, exportId).run();
    const binding = await env.DB.prepare('SELECT export_id FROM sk_viewers WHERE viewer_id = ?1').bind(viewerId).first();
    if (binding.export_id !== exportId) return fail('Viewer was assigned to another export. Contact the study operator before reusing this viewer.', 409);
    await env.DB.prepare('INSERT OR IGNORE INTO sk_sessions(id, viewer_id, export_id, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(crypto.randomUUID(), viewerId, exportId, new Date().toISOString()).run();
    const found = await env.DB.prepare('SELECT id FROM sk_sessions WHERE viewer_id = ?1 AND export_id = ?2').bind(viewerId, exportId).first();
    return json({ session_id: found.id });
  }
  if (path === '/api/study/next' && request.method === 'POST') {
    const current = await session(env, body.token, body.session_id, exportId);
    if (!current) return fail('Invalid session', 403);
    let tasks;
    try { tasks = await assignedTasks(env, active, current.viewer_id); } catch (error) { return fail(error.message, 403); }
    const previous = await all(env.DB.prepare('SELECT * FROM sk_responses WHERE export_id = ?1 AND viewer_id = ?2 ORDER BY sequence')
      .bind(exportId, current.viewer_id));
    const originals = previous.filter(r => !r.is_repeat);
    const repeats = previous.filter(r => r.is_repeat);
    const pending = await env.DB.prepare('SELECT * FROM sk_trials WHERE export_id = ?1 AND viewer_id = ?2 AND answered_at IS NULL')
      .bind(exportId, current.viewer_id).first();
    if (pending) return json(trialResult(pending, tasks, batch, originals.length));
    const done = new Set(originals.map(r => r.task));
    const candidates = orderedTasks(tasks, current.viewer_id).filter(t => !done.has(t.task_id));
    const lastTask = tasks.find(t => t.task_id === previous.at(-1)?.task);
    let task = candidates.find(t => t.clip_id !== lastTask?.clip_id) || candidates[0];
    let isRepeat = false;
    if (repeats.length < Math.floor(originals.length * active.settings.repeat_rate)) {
      const alreadyRepeated = new Set(repeats.map(r => r.task));
      const eligible = originals.slice(0, -10).find(r => !alreadyRepeated.has(r.task) && r.task !== previous.at(-1)?.task);
      if (eligible) { task = tasks.find(t => t.task_id === eligible.task); isRepeat = true; }
    }
    if (!task) return json(null);
    const trial = { id: crypto.randomUUID(), task_id: task.task_id };
    try {
      await env.DB.prepare(`INSERT INTO sk_trials(id, session_id, viewer_id, export_id, task_id, clip_id, is_repeat, issued_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
        .bind(trial.id, current.id, current.viewer_id, exportId, task.task_id, task.clip_id, isRepeat ? 1 : 0, new Date().toISOString()).run();
    } catch (error) {
      if (!/UNIQUE|constraint/i.test(String(error.message))) throw error;
      const winner = await env.DB.prepare('SELECT * FROM sk_trials WHERE export_id = ?1 AND viewer_id = ?2 AND answered_at IS NULL')
        .bind(exportId, current.viewer_id).first();
      if (!winner) return fail('Trial changed; reload the task', 409);
      return json(trialResult(winner, tasks, batch, originals.length));
    }
    return json(trialResult(trial, tasks, batch, originals.length));
  }
  if (path === '/api/study/respond' && request.method === 'POST') {
    const current = await session(env, body.token, body.session_id, exportId);
    if (!current) return fail('Invalid session', 403);
    const trial = await env.DB.prepare('SELECT * FROM sk_trials WHERE id = ?1 AND session_id = ?2 AND export_id = ?3')
      .bind(body.trial_id, current.id, exportId).first();
    if (!trial) return fail('Unknown trial');
    try {
      const tasks = await assignedTasks(env, active, current.viewer_id);
      if (!tasks.some(task => task.task_id === trial.task_id)) return fail('Trial is outside the assigned viewer group', 409);
    } catch (error) { return fail(error.message, 403); }
    try { validateChoice(body.choice, body.playback_complete); } catch (error) { return fail(error.message); }
    const existing = await env.DB.prepare('SELECT * FROM sk_responses WHERE response_id = ?1').bind(trial.id).first();
    if (existing) return existing.choice === body.choice && Boolean(existing.playback_complete) === body.playback_complete
      ? json({ saved: true }) : fail('Trial already answered differently', 409);
    const timestamp = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO sk_responses(response_id, export_id, task, viewer_id, session_id, choice, playback_complete, is_repeat, timestamp)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
          .bind(trial.id, exportId, trial.task_id, current.viewer_id, current.id, body.choice, body.playback_complete ? 1 : 0, trial.is_repeat, timestamp),
        env.DB.prepare('UPDATE sk_trials SET answered_at = ?1 WHERE id = ?2').bind(timestamp, trial.id),
      ]);
    } catch (error) {
      if (/UNIQUE|constraint/i.test(String(error.message))) return fail('Response already saved; reload the task', 409);
      throw error;
    }
    return json({ saved: true });
  }
  return fail('Not found', 404);
}
