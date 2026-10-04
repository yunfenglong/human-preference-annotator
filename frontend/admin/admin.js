import { createStudyDashboard } from './study.js';
const $ = id => document.getElementById(id);
let adminToken = '';
function adminFetch(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Admin-Token', adminToken);
  return fetch(`/api${path}`, { ...options, headers });
}
const study = createStudyDashboard(adminFetch);
$('loginForm').onsubmit = async event => {
  event.preventDefault(); $('loginBtn').disabled = true; $('loginMsg').textContent = 'Signing in…';
  try {
    const result = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('adminPassword').value }) });
    if (!result.ok) throw new Error('Invalid password');
    adminToken = (await result.json()).token;
    $('adminPassword').value = ''; $('loginSection').hidden = true; $('dash').hidden = false; $('loginMsg').textContent = '';
    await study.refresh();
  } catch (error) { $('loginMsg').textContent = error.message; }
  finally { $('loginBtn').disabled = false; }
};
const settingKeys = ['cantTell', 'surprise', 'attention'];
$('legacyTools').ontoggle = async () => {
  if (!$('legacyTools').open) return;
  try {
    const response = await adminFetch('/admin/settings');
    if (!response.ok) throw new Error('Could not load legacy settings');
    const settings = await response.json();
    for (const key of settingKeys) { $('setting-' + key).checked = settings[key]; $('setting-' + key).disabled = false; }
    $('saveSettings').disabled = false;
  } catch (error) { $('settingsMsg').textContent = error.message; }
};
$('settingsForm').onsubmit = async event => {
  event.preventDefault(); $('saveSettings').disabled = true;
  try {
    const settings = Object.fromEntries(settingKeys.map(key => [key, $('setting-' + key).checked]));
    const response = await adminFetch('/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    if (!response.ok) throw new Error('Could not save legacy settings');
    $('settingsMsg').textContent = 'Settings saved.';
  } catch (error) { $('settingsMsg').textContent = error.message; }
  finally { $('saveSettings').disabled = false; }
};
$('legacyDownload').onclick = async () => {
  const response = await adminFetch('/admin/export');
  if (!response.ok) { $('settingsMsg').textContent = 'Could not export legacy annotations'; return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'legacy_annotations.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('legacyFlush').onclick = async () => {
  if (!confirm('Delete all legacy driving annotations and progress?')) return;
  const response = await adminFetch('/admin/flush', { method: 'POST' });
  $('settingsMsg').textContent = response.ok ? 'Legacy driving data reset.' : 'Could not reset legacy data.';
};
