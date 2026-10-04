import { readBatch } from './study-batches.js';

const conflict = message => Object.assign(new Error(message), { status: 409 });
function groupFor(source, groupId) {
  if (source.assignment) {
    if (typeof groupId !== 'string' || !source.assignment.groups.has(groupId)) throw new Error('Select a viewer group from RATER_ASSIGNMENT.csv');
  } else if (groupId) throw new Error('This batch has no viewer assignment groups');
}

export async function assignedTasks(env, study, viewerId) {
  if (!study.assignment) return study.manifest.tasks;
  const binding = await env.DB.prepare('SELECT group_id, assignment_sha256 FROM sk_viewer_groups WHERE export_id = ?1 AND viewer_id = ?2')
    .bind(study.exportId, viewerId).first();
  const tasks = binding && binding.assignment_sha256 === study.assignment.hash && study.assignment.groups.get(binding.group_id);
  if (!tasks) throw new Error('Ask the admin to assign your viewer ID to a group in the dashboard');
  return study.manifest.tasks.filter(task => tasks.has(task.task_id));
}

export async function studyViewers(env, batch) {
  const source = await readBatch(env, batch);
  const rows = await env.DB.prepare(`SELECT t.annotator_id AS viewer_id, t.token, g.group_id, g.assignment_sha256,
    EXISTS(SELECT 1 FROM sk_sessions s WHERE s.export_id = ?1 AND s.viewer_id = t.annotator_id) AS enrolled,
    EXISTS(SELECT 1 FROM sk_viewers v WHERE v.viewer_id = t.annotator_id AND v.export_id != ?1) AS other_export,
    (SELECT COUNT(*) FROM sk_responses r WHERE r.export_id = ?1 AND r.viewer_id = t.annotator_id AND r.is_repeat = 0) AS completed,
    (SELECT COUNT(*) FROM sk_responses r WHERE r.export_id = ?1 AND r.viewer_id = t.annotator_id AND r.is_repeat = 1) AS repeats
    FROM tokens t LEFT JOIN sk_viewer_groups g ON g.export_id = ?1 AND g.viewer_id = t.annotator_id ORDER BY t.annotator_id`)
    .bind(source.exportId).all();
  return { batch, groups: source.assignment?.summary ?? [], viewers: rows.results.map(row => {
    const group = row.assignment_sha256 === source.assignment?.hash ? row.group_id : null;
    return { viewer_id: row.viewer_id, token: row.token, group_id: group,
      completed: row.completed, repeats: row.repeats, enrolled: Boolean(row.enrolled), other_export: Boolean(row.other_export),
      group_locked: Boolean(row.enrolled && (row.group_id || row.completed || row.repeats)),
      total: source.assignment ? (source.assignment.groups.get(group)?.size ?? 0) : source.manifest.tasks.length };
  }) };
}

async function ensureExport(env, viewerId, exportId) {
  const existing = await env.DB.prepare('SELECT export_id FROM sk_viewers WHERE viewer_id = ?1').bind(viewerId).first();
  if (existing && existing.export_id !== exportId) throw conflict('Viewer belongs to another export. Use an appropriate new viewer ID.');
}

export async function setViewerGroup(env, batch, viewerId, groupId) {
  const source = await readBatch(env, batch);
  groupFor(source, groupId);
  if (!source.assignment) throw new Error('This batch has no viewer assignment groups');
  const viewer = await env.DB.prepare('SELECT annotator_id FROM tokens WHERE annotator_id = ?1').bind(viewerId).first();
  if (!viewer) throw new Error('Viewer ID does not exist');
  await ensureExport(env, viewerId, source.exportId);
  const existingGroup = await env.DB.prepare('SELECT group_id FROM sk_viewer_groups WHERE export_id = ?1 AND viewer_id = ?2').bind(source.exportId, viewerId).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sk_viewer_groups(export_id, viewer_id, group_id, assignment_sha256)
    SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM sk_sessions WHERE export_id = ?1 AND viewer_id = ?2)
      OR (NOT EXISTS (SELECT 1 FROM sk_viewer_groups WHERE export_id = ?1 AND viewer_id = ?2)
          AND NOT EXISTS (SELECT 1 FROM sk_responses WHERE export_id = ?1 AND viewer_id = ?2))
    ON CONFLICT(export_id, viewer_id) DO UPDATE SET group_id = excluded.group_id, assignment_sha256 = excluded.assignment_sha256
    WHERE NOT EXISTS (SELECT 1 FROM sk_sessions WHERE export_id = ?1 AND viewer_id = ?2)`)
      .bind(source.exportId, viewerId, groupId, source.assignment.hash),
    // Repair pre-group sessions only: retain the session but invalidate old unassigned pending trials.
    env.DB.prepare(`DELETE FROM sk_trials WHERE export_id = ?1 AND viewer_id = ?2 AND answered_at IS NULL AND ?5 = 1
      AND NOT EXISTS (SELECT 1 FROM sk_responses WHERE export_id = ?1 AND viewer_id = ?2)
      AND EXISTS (SELECT 1 FROM sk_viewer_groups WHERE export_id = ?1 AND viewer_id = ?2 AND group_id = ?3 AND assignment_sha256 = ?4)`)
      .bind(source.exportId, viewerId, groupId, source.assignment.hash, existingGroup ? 0 : 1),
  ]);
  const saved = await env.DB.prepare('SELECT group_id, assignment_sha256 FROM sk_viewer_groups WHERE export_id = ?1 AND viewer_id = ?2')
    .bind(source.exportId, viewerId).first();
  if (saved?.group_id !== groupId || saved?.assignment_sha256 !== source.assignment.hash) throw conflict('Viewer group is locked after enrollment');
  return { viewer_id: viewerId, group_id: groupId };
}

export async function createStudyViewer(env, batch, viewerId, groupId) {
  if (typeof viewerId !== 'string' || !viewerId.trim() || viewerId.trim().length > 128 || /[\x00-\x1f\x7f]/.test(viewerId)) throw new Error('A pseudonymous viewer ID is required');
  viewerId = viewerId.trim();
  const source = await readBatch(env, batch);
  groupFor(source, groupId);
  await ensureExport(env, viewerId, source.exportId);
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const statements = [env.DB.prepare('INSERT INTO tokens(annotator_id, token) VALUES (?1, ?2)').bind(viewerId, token)];
  if (source.assignment) statements.push(env.DB.prepare('INSERT INTO sk_viewer_groups(export_id, viewer_id, group_id, assignment_sha256) VALUES (?1, ?2, ?3, ?4)')
    .bind(source.exportId, viewerId, groupId, source.assignment.hash));
  try { await env.DB.batch(statements); }
  catch (error) { if (/UNIQUE|constraint/i.test(error.message)) throw conflict('Viewer ID already exists'); throw error; }
  return { viewer_id: viewerId, group_id: source.assignment ? groupId : null, token };
}
