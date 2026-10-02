const $ = id => document.getElementById(id);
let adminToken, config, pendingCursor;
const status = text => { $('status').textContent = text; };
async function admin(path) {
  const result = await fetch(`/api/admin/study/${path}`, { headers: { 'X-Admin-Token': adminToken } });
  if (!result.ok) throw new Error((await result.json()).error || 'Request failed');
  return result;
}
$('signIn').onclick = async () => {
  try {
    const result = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
    if (!result.ok) throw new Error("Incorrect password.");
    adminToken = (await result.json()).token;
    const setup = await fetch('/api/study/config'); config = await setup.json();
    if (!setup.ok) throw new Error(config.error);
    $('password').value = ''; $('login').hidden = true; $('operations').hidden = false;
    $('identity').textContent = `Seed ${config.seed} · Export ${config.export_id}${config.fixture ? ' · Test export' : ''}`;
    $('after').value = localStorage.getItem(`sk-imported:${config.export_id}`) || '0';
    $('progress').textContent = JSON.stringify(await (await admin('progress')).json(), null, 2);
    status("Signed in.");
  } catch (error) { status(error.message); }
};
$('download').onclick = async () => {
  try {
    const after = $('after').value;
    if (!/^\d+$/.test(after)) throw new Error("Enter 0 or a larger whole number.");
    const result = await admin(`export?after=${encodeURIComponent(after)}`);
    const payload = await result.json();
    if (!payload.responses.length) { status("No new answers to download."); return; }
    pendingCursor = result.headers.get('x-export-cursor');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
    link.download = result.headers.get('content-disposition').match(/filename="([^"]+)"/)[1]; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    $('acknowledge').disabled = false;
    status(`Downloaded ${payload.responses.length} answers. Click “Mark as imported” after the import succeeds.`);
  } catch (error) { status(error.message); }
};
$('acknowledge').onclick = () => {
  if (!pendingCursor) return;
  localStorage.setItem(`sk-imported:${config.export_id}`, pendingCursor);
  $('after').value = pendingCursor; pendingCursor = null; $('acknowledge').disabled = true;
  status("Saved. This browser will skip these answers next time. Copy the cursor if you switch browsers.");
};
