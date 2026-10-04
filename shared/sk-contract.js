export const TASK_SCHEMA = 'sk_labeling_task_export_v1';
export const RESPONSE_SCHEMA = 'sk_labeling_responses_v1';
export const CHOICES = ['A', 'B', 'tie', 'uncertain', 'technical_failure'];
const hex = (s, n) => typeof s === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(s);
const required = (ok, message) => { if (!ok) throw new TypeError(message); };

export function validateTasks(manifest) {
  required(manifest?.schema === TASK_SCHEMA, `schema must be ${TASK_SCHEMA}`);
  required(Number.isSafeInteger(manifest.seed), 'seed must be an integer');
  required(typeof manifest.fixture === 'boolean', 'fixture must be a boolean');
  required(typeof manifest.bundle?.question_id === 'string' && manifest.bundle.question_id.trim(), 'question_id required');
  for (const key of ['display_sha256', 'protocol_sha256']) required(hex(manifest.bundle[key], 64), `${key} must be a SHA-256`);
  required(Array.isArray(manifest.tasks) && manifest.tasks.length > 0 && manifest.task_count === manifest.tasks.length, 'task_count must match nonempty tasks');
  const ids = new Set();
  for (const task of manifest.tasks) {
    required(hex(task.task_id, 16) && !ids.has(task.task_id), 'task_id must be unique opaque 16-character hex');
    ids.add(task.task_id);
    required(hex(task.clip_id, 16), 'clip_id must be opaque 16-character hex');
    required(task.question_id === manifest.bundle.question_id, 'task question_id must match bundle');
    for (const side of ['A', 'B']) {
      const stimulus = task.stimuli?.[side];
      required(typeof stimulus?.file === 'string' && new RegExp(`^stimuli/${task.task_id}_${side}(?:_[A-Za-z0-9-]+)*\\.mp4$`).test(stimulus.file), 'unexpected stimulus path');
      required(hex(stimulus.sha256, 64), 'stimulus sha256 required');
    }
    const v = task.video;
    required(v?.layout === 'side_by_side_left_right', 'unsupported stereo layout');
    for (const key of ['eye_width', 'eye_height', 'frames']) required(Number.isSafeInteger(v[key]) && v[key] > 0, `invalid video ${key}`);
    required(typeof v.fps === 'string' && /^\d+(?:\.\d+)?(?:\/\d+)?$/.test(v.fps), 'fps must be a rational string');
    const [n, d = 1] = v.fps.split('/').map(Number);
    required(n > 0 && d > 0 && Number.isFinite(v.duration_s) && Math.abs(v.duration_s - v.frames * d / n) < 1e-6, 'duration_s must equal frames / fps');
  }
  return manifest;
}

// Publish a strict allowlist. Never echo operator metadata into the blind UI.
export function publicTask(task, batch) {
  return {
    task_id: task.task_id, clip_id: task.clip_id, question_id: task.question_id,
    video: Object.fromEntries(["layout", "eye_width", "eye_height", "frames", "fps", "duration_s"].map(key => [key, task.video[key]])),
    stimuli: Object.fromEntries(['A', 'B'].map(side => [side, {
      file: `/videos/batches/${encodeURIComponent(batch)}/${task.stimuli[side].file}`,
      sha256: task.stimuli[side].sha256,
    }])),
  };
}

export function validateChoice(choice, playbackComplete) {
  required(CHOICES.includes(choice), 'invalid choice');
  required(typeof playbackComplete === 'boolean', 'playback_complete must be a JSON boolean');
  required(!['A', 'B', 'tie'].includes(choice) || playbackComplete, 'A, B and tie require complete playback of both stimuli');
}

export function responsePayload(rows) {
  return { schema: RESPONSE_SCHEMA, responses: rows.map(row => ({
    response_id: row.response_id, task: row.task, viewer_id: row.viewer_id,
    session_id: row.session_id, choice: row.choice,
    playback_complete: Boolean(row.playback_complete), repeat: Boolean(row.is_repeat), timestamp: row.timestamp,
  })) };
}

// Stable per-viewer order; preserve the seed's A/B assignment.
export function orderedTasks(tasks, viewerId) {
  const rank = value => {
    let h = 2166136261;
    for (const c of `${viewerId}:${value}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h;
  };
  return [...tasks].sort((a, b) => rank(a.task_id) - rank(b.task_id) || a.task_id.localeCompare(b.task_id));
}
