export function createStudyDashboard(adminFetch) {
  const $ = id => document.getElementById(id);
  let config, pendingCursor, selectionVersion = 0;
  const status = text => { $('studyStatus').textContent = text; };
  async function admin(path, body) {
    const result = await adminFetch(`/admin/study/${path}`, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : {});
    if (!result.ok) throw new Error((await result.json()).error || 'Request failed');
    return result;
  }
  const textCell = text => { const td = document.createElement('td'); td.textContent = text; return td; };
  function groupOptions(select, groups, selected = '') {
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = '';
    placeholder.textContent = groups.length ? 'Choose group' : 'All batch tasks'; select.appendChild(placeholder);
    for (const group of groups) {
      const option = document.createElement('option'); option.value = group.group_id;
      option.textContent = `${group.group_id} (${group.task_count} tasks)`; select.appendChild(option);
    }
    select.value = selected || '';
  }
  function resetSelection() {
    pendingCursor = null; config = null;
    $('acknowledge').disabled = true; $('download').disabled = true;
    $('addViewer').disabled = true; $('refreshViewers').disabled = true;
    $('viewerTable').querySelector('tbody').replaceChildren();
    $('viewerStatus').textContent = ''; $('generatedViewer').textContent = '';
    $('batchSetup').hidden = true; $('identity').textContent = ''; $('batchInfo').textContent = '';
    $('groupSummary').replaceChildren(); $('assignmentNote').textContent = '';
    groupOptions($('newViewerGroup'), []); $('newViewerGroup').disabled = true;
  }
  async function refreshViewers(selected = config, version = selectionVersion) {
    if (!selected) return;
    const result = await (await admin(`viewers?batch=${encodeURIComponent(selected.batch)}`)).json();
    if (version !== selectionVersion) return;
    const tbody = $('viewerTable').querySelector('tbody'); tbody.replaceChildren();
    for (const viewer of result.viewers) {
      const tr = document.createElement('tr'); tr.appendChild(textCell(viewer.viewer_id));
      const groupCell = document.createElement('td');
      const select = document.createElement('select'); select.setAttribute('aria-label', `Group for ${viewer.viewer_id}`);
      groupOptions(select, result.groups, viewer.group_id);
      select.disabled = viewer.group_locked || viewer.other_export || !result.groups.length;
      groupCell.appendChild(select);
      if (result.groups.length && !viewer.group_locked && !viewer.other_export) {
        const save = document.createElement('button'); save.textContent = 'Save group'; save.disabled = true;
        select.onchange = () => { save.disabled = !select.value || select.value === viewer.group_id; };
        save.onclick = async () => {
          save.disabled = true;
          try {
            await admin('viewer-group', { batch: selected.batch, viewer_id: viewer.viewer_id, group_id: select.value });
            if (version !== selectionVersion) return;
            await refreshViewers(selected, version); $('viewerStatus').textContent = `Group saved for ${viewer.viewer_id}.`;
          } catch (error) { if (version === selectionVersion) { $('viewerStatus').textContent = error.message; save.disabled = false; } }
        };
        groupCell.appendChild(save);
      }
      if (viewer.group_locked || viewer.other_export) {
        const note = document.createElement('div'); note.className = 'muted';
        note.textContent = viewer.other_export ? 'Belongs to another export' : 'Group locked'; groupCell.appendChild(note);
      }
      tr.appendChild(groupCell);
      tr.appendChild(textCell(viewer.other_export ? '—' : result.groups.length && !viewer.group_id ? 'Choose group' : `${viewer.completed} / ${viewer.total}`));
      tr.appendChild(textCell(String(viewer.repeats)));
      const actions = document.createElement('td');
      const url = `${location.origin}/?token=${encodeURIComponent(viewer.token)}`;
      const copy = document.createElement('button'); copy.textContent = 'Copy link';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(url); $('viewerStatus').textContent = `Link copied for ${viewer.viewer_id}.`; } catch { $('viewerStatus').textContent = 'Could not copy. Use Open link.'; } };
      const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open';
      const remove = document.createElement('button'); remove.textContent = 'Remove';
      remove.onclick = async () => {
        if (!confirm(`Remove the viewer link for ${viewer.viewer_id}?`)) return;
        try {
          const response = await adminFetch('/admin/remove-annotator', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotatorId: viewer.viewer_id }) });
          if (!response.ok) throw new Error('Could not remove viewer link');
          await refreshViewers(selected, version);
        } catch (error) { if (version === selectionVersion) $('viewerStatus').textContent = error.message; }
      };
      actions.append(copy, link, remove); tr.appendChild(actions); tbody.appendChild(tr);
    }
    $('viewerStatus').textContent = result.viewers.length ? `${result.viewers.length} viewer IDs loaded.` : 'Add a viewer ID and choose its group below.';
    $('refreshViewers').disabled = false; $('addViewer').disabled = false;
  }
  async function selectBatch() {
    const version = ++selectionVersion, batch = $('batch').value;
    resetSelection();
    if (!batch) { status('Upload a batch with TASKS.json and stimuli/, then refresh.'); return; }
    status('Loading batch…');
    try {
      const selected = await (await admin(`batch?batch=${encodeURIComponent(batch)}`)).json();
      if (version !== selectionVersion) return;
      config = selected;
      $('identity').textContent = `${batch} · ${config.task_count} total batch tasks · Seed ${config.seed}${config.fixture ? ' · Test export' : ''}`;
      for (const group of config.groups) {
        const item = document.createElement('span'); item.textContent = `${group.group_id} · ${group.task_count} tasks`; $('groupSummary').appendChild(item);
      }
      $('assignmentNote').textContent = config.groups.length ? 'RATER_ASSIGNMENT.csv defines these groups. Each viewer receives only the tasks in their selected group.' : 'No RATER_ASSIGNMENT.csv in this batch. Each viewer receives all batch tasks.';
      groupOptions($('newViewerGroup'), config.groups);
      $('newViewerGroup').disabled = !config.groups.length; $('newViewerGroup').required = !!config.groups.length;
      $('batchInfo').textContent = [`Question ID: ${config.bundle.question_id}`, config.display_description, config.viewing_instructions].filter(Boolean).join('\n');
      $('question').value = config.settings?.question || ''; $('setupInstructions').value = config.settings?.setup_instructions || '';
      $('repeatRate').value = config.settings?.repeat_rate ?? 0.1; $('setupConfirmed').checked = config.settings?.setup_confirmed === true;
      $('batchSetup').hidden = false; $('setupDetails').open = !config.configured; $('activateBatch').disabled = false;
      $('after').value = localStorage.getItem(`sk-imported:${config.export_id}`) || '0'; $('download').disabled = !config.configured;
      await refreshViewers(selected, version);
      if (version !== selectionVersion) return;
      status(config.configured ? 'Batch loaded.' : 'Assign viewer groups and confirm the viewing setup before activating this batch.');
    } catch (error) { if (version === selectionVersion) status(error.message); }
  }
  async function loadBatches(preferred) {
    let cursor, active, batches = [];
    do {
      const page = await (await admin(`batches${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)).json();
      batches.push(...page.batches); active = page.active_batch; cursor = page.cursor;
    } while (cursor);
    $('batch').replaceChildren();
    for (const item of batches) {
      const option = document.createElement('option'); option.value = item.batch; option.textContent = `${item.batch}${item.active ? ' (active)' : ''}`; $('batch').appendChild(option);
    }
    const selected = preferred || active;
    if (selected && batches.some(item => item.batch === selected)) $('batch').value = selected;
    $('activeBatch').textContent = active ? `Active batch: ${active}` : 'No active batch selected.';
    await selectBatch();
  }
  $('batch').onchange = selectBatch;
  $('refreshBatches').onclick = async () => {
    $('refreshBatches').disabled = true;
    try { await loadBatches($('batch').value); } catch (error) { status(error.message); }
    finally { $('refreshBatches').disabled = false; }
  };
  $('refreshViewers').onclick = async () => {
    $('refreshViewers').disabled = true;
    try { await refreshViewers(); } catch (error) { $('viewerStatus').textContent = error.message; }
    finally { $('refreshViewers').disabled = !config; }
  };
  $('addViewerForm').onsubmit = async event => {
    event.preventDefault(); if (!config) return;
    const selected = config, version = selectionVersion; $('addViewer').disabled = true;
    try {
      const result = await (await admin('viewer', { batch: selected.batch, viewer_id: $('newViewerId').value.trim(), group_id: $('newViewerGroup').value || null })).json();
      if (version !== selectionVersion) return;
      $('newViewerId').value = ''; await refreshViewers(selected, version);
      $('generatedViewer').textContent = `Created ${result.viewer_id}${result.group_id ? ` in ${result.group_id}` : ''}. Copy its link from the table.`;
    } catch (error) { if (version === selectionVersion) $('viewerStatus').textContent = error.message; }
    finally { if (version === selectionVersion) $('addViewer').disabled = false; }
  };
  $('batchSetup').onsubmit = async event => {
    event.preventDefault(); if (!config) return;
    const selected = config;
    $('activateBatch').disabled = true; $('batch').disabled = true; $('refreshBatches').disabled = true;
    try {
      const settings = { ...selected.bundle, question: $('question').value.trim(), setup_instructions: $('setupInstructions').value.trim(),
        setup_confirmed: $('setupConfirmed').checked, repeat_rate: Number($('repeatRate').value) };
      await admin('activate', { batch: selected.batch, settings }); await loadBatches(selected.batch);
      status(`Activated ${selected.batch}. Viewer links now use this batch and their assigned groups.`);
    } catch (error) { status(error.message); }
    finally { $('activateBatch').disabled = false; $('batch').disabled = false; $('refreshBatches').disabled = false; }
  };
  $('download').onclick = async () => {
    if (!config?.configured) return;
    const selected = config, version = selectionVersion; $('download').disabled = true;
    try {
      const after = $('after').value; if (!/^\d+$/.test(after)) throw new Error('Enter 0 or a larger whole number.');
      const result = await admin(`export?batch=${encodeURIComponent(selected.batch)}&after=${encodeURIComponent(after)}`);
      const payload = await result.json(); if (version !== selectionVersion) return;
      if (!payload.responses.length) { status('No new answers to download.'); return; }
      pendingCursor = result.headers.get('x-export-cursor');
      const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      link.download = result.headers.get('content-disposition').match(/filename="([^"]+)"/)[1]; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000); $('acknowledge').disabled = false;
      status(`Downloaded ${payload.responses.length} answers. Mark as imported after pixelMorph imports the file.`);
    } catch (error) { if (version === selectionVersion) status(error.message); }
    finally { if (version === selectionVersion) $('download').disabled = false; }
  };
  $('acknowledge').onclick = () => {
    if (!pendingCursor || !config) return;
    localStorage.setItem(`sk-imported:${config.export_id}`, pendingCursor);
    $('after').value = pendingCursor; pendingCursor = null; $('acknowledge').disabled = true; status('Import cursor saved in this browser.');
  };
  return { refresh: async () => { try { await loadBatches(); } catch (error) { status(error.message); } } };
}
