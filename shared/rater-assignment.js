// RFC-style CSV fields: accept BOM, CRLF, quoted fields and escaped quotes.
function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  const pushField = () => { row.push(field.trim()); field = ''; closed = false; };
  const pushRow = () => { pushField(); if (row.some(Boolean)) rows.push(row); row = []; };
  text = text.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      if (c === ',') pushField();
      else { pushRow(); if (c === '\r' && text[i + 1] === '\n') i++; }
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error('Malformed RATER_ASSIGNMENT.csv quoting');
      field += c;
    }
  }
  if (quoted) throw new Error('Unclosed RATER_ASSIGNMENT.csv quoted field');
  if (field || row.length) pushRow();
  return rows;
}

export function parseRaterAssignment(text, manifest) {
  const [header, ...rows] = csvRows(text);
  const columns = ['task_id', 'clip_id', 'viewer_id'];
  if (!header || new Set(header).size !== header.length || columns.some(key => !header.includes(key))) {
    throw new Error('RATER_ASSIGNMENT.csv requires task_id, clip_id and viewer_id columns');
  }
  if (!rows.length) throw new Error('RATER_ASSIGNMENT.csv has no assignments');
  const tasks = new Map(manifest.tasks.map(task => [task.task_id, task]));
  const groups = new Map(), covered = new Set();
  for (const row of rows) {
    if (row.length !== header.length) throw new Error('Malformed RATER_ASSIGNMENT.csv row');
    const [taskId, clipId, groupId] = columns.map(key => row[header.indexOf(key)]);
    if (!groupId || groupId.length > 100 || /[\x00-\x1f\x7f]/.test(groupId)) throw new Error('Invalid viewer group in RATER_ASSIGNMENT.csv');
    const task = tasks.get(taskId);
    if (!task || task.clip_id !== clipId) throw new Error('RATER_ASSIGNMENT.csv task_id / clip_id does not match TASKS.json');
    if (!groups.has(groupId)) groups.set(groupId, new Set());
    if (groups.get(groupId).has(taskId)) throw new Error('Duplicate task within a viewer group in RATER_ASSIGNMENT.csv');
    groups.get(groupId).add(taskId); covered.add(taskId);
  }
  if (covered.size !== tasks.size) throw new Error('RATER_ASSIGNMENT.csv must cover every TASKS.json task');
  return { groups, summary: [...groups].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([group_id, tasks]) => ({ group_id, task_count: tasks.size })) };
}
