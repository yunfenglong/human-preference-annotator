#!/usr/bin/env node
import { readFile, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateTasks } from '../shared/sk-contract.js';

// Validate the entire handoff before uploading anything. No private maps are read.
export async function inspectExport(folder, settingsPath) {
  const root = await realpath(folder);
  const bytes = await readFile(join(root, 'TASKS.json'));
  const manifest = validateTasks(JSON.parse(bytes));
  const settings = JSON.parse(await readFile(settingsPath));
  for (const field of ['question_id', 'display_sha256', 'protocol_sha256']) {
    if (settings[field] !== manifest.bundle[field]) throw new Error(`STUDY.json ${field} must match TASKS.json`);
  }
  if (settings.setup_confirmed !== true || typeof settings.question !== 'string' || !settings.question.trim() ||
      typeof settings.setup_instructions !== 'string' || !settings.setup_instructions.trim()) {
    throw new Error('Set agreed question, setup_instructions and setup_confirmed: true before collecting');
  }
  if (typeof settings.repeat_rate !== 'number' || settings.repeat_rate < 0 || settings.repeat_rate > 0.5) throw new Error('repeat_rate must be between 0 and 0.5');
  const files = [];
  for (const task of manifest.tasks) {
    for (const side of ['A', 'B']) {
      const stimulus = task.stimuli[side];
      const path = await realpath(join(root, stimulus.file));
      if (!path.startsWith(root + sep)) throw new Error('Stimulus symlink escapes delivery folder');
      const content = await readFile(path);
      const hash = createHash('sha256').update(content).digest('hex');
      if (hash !== stimulus.sha256) throw new Error(`SHA-256 mismatch: ${stimulus.file}`);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
        '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate', '-of', 'json', path], { encoding: 'utf8' })).streams[0];
      const rational = text => { const [n, d = 1] = text.split('/').map(Number); return n / d; };
      if (!probe || probe.width !== 2 * task.video.eye_width || probe.height !== task.video.eye_height ||
          Number(probe.nb_read_frames) !== task.video.frames || Math.abs(rational(probe.avg_frame_rate) - rational(task.video.fps)) > 1e-6) {
        throw new Error(`Geometry / frame count / FPS mismatch: ${stimulus.file}`);
      }
      files.push({ relative: stimulus.file, path });
    }
  }
  return { exportId: createHash('sha256').update(bytes).digest('hex'), manifest, settings, bytes, files };
}

async function main() {
  const [folder, settingsPath, ...flags] = process.argv.slice(2);
  if (!folder || !settingsPath || flags.some(f => !['--local', '--remote', '--verify-only'].includes(f)) ||
      flags.filter(f => ['--local', '--remote'].includes(f)).length > 1 ||
      (flags.includes('--verify-only') && flags.some(f => ['--local', '--remote'].includes(f)))) {
    throw new Error('Usage: node scripts/import_sk_tasks.mjs EXPORT_FOLDER STUDY.json [--verify-only | --local | --remote]');
  }
  const inspected = await inspectExport(resolve(folder), resolve(settingsPath));
  console.log(`Verified ${inspected.manifest.task_count} tasks (${inspected.manifest.fixture ? 'FIXTURE' : 'real'}), seed ${inspected.manifest.seed}`);
  console.log(`SK_EXPORT_ID=${inspected.exportId}`);
  if (!flags.includes('--local') && !flags.includes('--remote')) return;
  const temporary = await mkdtemp(join(tmpdir(), 'sk-verified-'));
  try {
    const upload = (relative, path, type) => execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'put',
      `human-preference-videos/videos/studies/${inspected.exportId}/${relative}`, '--file', path, '--content-type', type,
      flags.includes('--remote') ? '--remote' : '--local'], { stdio: 'inherit' });
    // Snapshot verified bytes, so a changed source is never uploaded under an old hash.
    for (const file of inspected.files) {
      const content = await readFile(file.path);
      const task = inspected.manifest.tasks.find(t => Object.values(t.stimuli).some(s => s.file === file.relative));
      const expected = Object.values(task.stimuli).find(s => s.file === file.relative).sha256;
      if (createHash('sha256').update(content).digest('hex') !== expected) throw new Error(`File changed after validation: ${file.relative}`);
      const snapshot = join(temporary, 'stimulus.mp4');
      await writeFile(snapshot, content);
      upload(file.relative, snapshot, 'video/mp4');
    }
    const settingsFile = join(temporary, 'STUDY.json');
    const tasksFile = join(temporary, 'TASKS.json');
    await writeFile(settingsFile, JSON.stringify(inspected.settings));
    await writeFile(tasksFile, inspected.bytes);
    upload('STUDY.json', settingsFile, 'application/json');
    upload('TASKS.json', tasksFile, 'application/json');
    console.log('Uploaded verified handoff. Set SK_EXPORT_ID in Worker vars and use fresh pseudonymous viewer IDs.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
