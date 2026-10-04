import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRaterAssignment } from '../shared/rater-assignment.js';
const manifest = { tasks: [{ task_id: 'task1', clip_id: 'clip1' }, { task_id: 'task2', clip_id: 'clip2' }] };
const csv = 'task_id,clip_id,viewer_id\ntask1,clip1,R1\ntask2,clip2,R2\n';
test('CSV parsing handles BOM, CRLF, quoted values and reordered columns', () => {
  const parsed = parseRaterAssignment('\ufeffviewer_id,clip_id,task_id\r\n"R1","clip1","task1"\r\n"R2","clip2","task2"\r\n', manifest);
  assert.deepEqual(parsed.summary, [{ group_id: 'R1', task_count: 1 }, { group_id: 'R2', task_count: 1 }]);
  assert.deepEqual([...parsed.groups.get('R1')], ['task1']);
});
test('invalid assignments reject malformed CSV, missing coverage, duplicates and wrong clips', () => {
  for (const invalid of [csv.replace('viewer_id','group'), csv.replace('clip1','wrong'),
    csv.replace('task1','unknown'), csv.replace('R1',''), csv + 'task1,clip1,R1\n',
    'task_id,clip_id,viewer_id\ntask1,clip1,R1\n', csv.replace('R1','"unclosed'),
    csv.replace('R1','"R1"extra'), csv.replace('R1','R"1')]) {
    assert.throws(() => parseRaterAssignment(invalid, manifest));
  }
});
