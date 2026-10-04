const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const metaQuest = /\bOculusBrowser\//i.test(navigator.userAgent) && /\bQuest(?:\s|;|\))/i.test(navigator.userAgent);
let config, sessionId, trial, popup, screenDetails, selectedScreen;
let urls = {}, complete = { A: false, B: false }, side = null, busy = false, ready = false, run = null;
let generation = 0;
const status = message => { $('status').textContent = message; };
const deadline = (promise, message, milliseconds = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), milliseconds);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

async function api(path, data) {
  const response = await fetch(`/api/study/${path}`, data ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...data }),
  } : {});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed. Try again.");
  return body;
}
function availability() {
  const displayReady = !!popup && !popup.closed && !!popup.document.getElementById('video');
  const setup = $('setupConfirmed').checked;
  $('playA').disabled = busy || !ready || !displayReady || (!setup && !metaQuest);
  $('playB').disabled = busy || !ready || !displayReady || !setup || !complete.A;
  document.querySelectorAll('[data-choice]').forEach(button => {
    button.disabled = busy || !trial || !setup || (['A', 'B', 'tie'].includes(button.dataset.choice) && !(complete.A && complete.B));
  });
}
function stop() {
  const video = popup && !popup.closed && popup.document.getElementById('video');
  if (video) video.pause();
  run = null;
}
function fullscreen() {
  if (!popup || popup.closed) return false;
  const element = popup.document.fullscreenElement;
  return element === popup.document.getElementById('stage') || (metaQuest && element === popup.document.getElementById('video'));
}

async function next() {
  const version = ++generation;
  busy = true; ready = false; trial = null; stop();
  complete = { A: false, B: false }; side = null;
  const video = popup && !popup.closed && popup.document.getElementById('video');
  if (video) { video.hidden = true; video.removeAttribute('src'); video.load(); }
  for (const url of Object.values(urls)) URL.revokeObjectURL(url);
  urls = {};
  availability();
  try {
    trial = await api('next', { session_id: sessionId });
    if (!trial) { status("You're done. Thanks for taking part."); $('progress').textContent = 'Complete'; $('judgment').hidden = true; return; }
    $('progress').textContent = `${trial.progress.completed} / ${trial.progress.total}`;
    $('judgment').hidden = false;
    status("Loading videos…");
    const loaded = await Promise.all(['A', 'B'].map(async label => {
      const stimulus = trial.task.stimuli[label];
      const response = await fetch(stimulus.file, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("Video won’t load. Choose “Video or display problem”.");
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== stimulus.sha256) throw new Error("This video can’t be played. Choose “Video or display problem”.");
      return [label, new Blob([bytes], { type: 'video/mp4' })];
    }));
    if (version !== generation) return;
    urls = Object.fromEntries(loaded.map(([label, blob]) => [label, URL.createObjectURL(blob)]));
    ready = true;
    status("Videos ready. Check your setup before playing.");
  } catch (error) { status(error.message); }
  finally { busy = false; availability(); }
}

function checkGeometry(video) {
  const geometry = trial.task.video;
  const ratio = popup.devicePixelRatio || 1;
  if (video.videoWidth !== geometry.eye_width * 2 || video.videoHeight !== geometry.eye_height) throw new Error("This video has the wrong size. Choose “Video or display problem”.");
  // One encoded pixel per physical display pixel. Center unchanged SBS bytes.
  const width = geometry.eye_width * 2 / ratio;
  const height = geometry.eye_height / ratio;
  if (popup.innerWidth + 0.1 < width || popup.innerHeight + 0.1 < height || (popup.visualViewport?.scale || 1) !== 1) {
    throw new Error("The video won’t fit this screen at full resolution. Choose “Video or display problem”.");
  }
  video.style.width = `${width}px`; video.style.height = `${height}px`;
}

async function play(label) {
  const setup = $('setupConfirmed').checked;
  if (busy || !ready || !trial || (!setup && !metaQuest) || (label === 'B' && !complete.A)) return;
  if (!popup || popup.closed) { status("Click “Open player” first."); return; }
  const stage = popup.document.getElementById('stage');
  const video = popup.document.getElementById('video');
  if (!stage || !video) return;
  busy = true; availability(); stop();
  const version = generation;
  try {
    if (metaQuest) {
      side = label;
      video.hidden = false;
      popup.document.getElementById('welcome').hidden = true;
      video.loop = false; video.controls = true; video.playbackRate = 1;
      video.src = urls[label];
    }
    // Fullscreen must begin directly from the click in the display window.
    const fullscreenTarget = metaQuest ? video : stage;
    if (!fullscreen()) await deadline(fullscreenTarget.requestFullscreen(selectedScreen ? { screen: selectedScreen, navigationUI: 'hide' } : { navigationUI: 'hide' }), "Couldn’t enter fullscreen. Click “Play fullscreen” in the video window.");
    if (version !== generation || !fullscreen()) return;
    if (!metaQuest) {
      side = label;
      video.hidden = false;
      popup.document.getElementById('welcome').hidden = true;
      video.loop = false; video.controls = false; video.playbackRate = 1;
      video.src = urls[label];
    }
    await deadline(new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("Video won’t play. Choose “Video or display problem”."));
      video.load();
    }), "Video didn’t load. Click “Play fullscreen” to try again.");
    if (version !== generation || !fullscreen()) return;
    if (!metaQuest) checkGeometry(video);
    video.currentTime = 0;
    run = { side: label, valid: true, started: false, last: 0 };
    await deadline(video.play(), "Video didn’t start. Click “Play fullscreen” to try again.");
    status(`Playing ${label}. Watch to the end.`);
  } catch (error) { stop(); status(error.message); }
  finally { busy = false; availability(); }
}

window.connectStudyDisplay = child => {
  if (child !== popup) return;
  const video = child.document.getElementById('video');
  child.document.getElementById('begin').onclick = () => play(complete.A ? 'B' : 'A');
  if (metaQuest) child.document.querySelector('#welcome p').textContent = "Open fullscreen, then set the player to 180° stereoscopic left-right. Return and confirm the setup before replaying A.";
  video.addEventListener('playing', () => {
    if (!run || !fullscreen() || video.playbackRate !== 1) { video.pause(); return; }
    if (!run.started) { run.started = video.currentTime < 0.25; if (!run.started) run.valid = false; }
  });
  video.addEventListener('seeking', () => { if (run?.started) run.valid = false; });
  video.addEventListener('ratechange', () => { if (run && video.playbackRate !== 1) run.valid = false; });
  video.addEventListener('timeupdate', () => {
    if (!run) return;
    if (!fullscreen() || child.document.hidden) { run.valid = false; video.pause(); }
    run.last = video.currentTime;
  });
  video.addEventListener('ended', () => {
    if (run?.valid && run.started && fullscreen()) {
      if (!$('setupConfirmed').checked) {
        status("Set the Meta Quest player to 180° stereoscopic left-right, confirm the setup, then replay A.");
      } else {
        complete[run.side] = true;
        status(complete.B ? "A and B finished. Choose an answer or replay either." : "A finished. Play B next.");
      }
    } else { status("Playback stopped early. Play this video again."); }
    run = null; availability();
  });
  video.addEventListener('error', () => { if (trial) { stop(); status("Video stopped playing. Choose “Video or display problem”."); availability(); } });
  child.document.addEventListener('fullscreenchange', () => {
    if (!fullscreen()) { stop(); video.hidden = true; child.document.getElementById('welcome').hidden = false; status("Fullscreen closed. Play this video again."); }
    availability();
  });
  child.document.addEventListener('visibilitychange', () => { if (child.document.hidden) stop(); });
  child.addEventListener('resize', () => {
    if (!fullscreen() || !trial || !video.videoWidth) return;
    try { checkGeometry(video); } catch (error) { stop(); status(error.message); }
  });
  child.addEventListener('pagehide', () => { stop(); popup = null; availability(); });
  child.addEventListener('keydown', event => {
    if (event.repeat) return;
    if (event.key === '1' || event.key === '2') { event.preventDefault(); play(event.key === '1' ? 'A' : 'B'); }
  });
  status("Click “Play fullscreen” in the video window to start A.");
  availability();
};

$('chooseScreen').onclick = async () => {
  try {
    if (!window.getScreenDetails) throw new Error("This browser can’t select a screen. Move the video window to your 3D display.");
    screenDetails = await window.getScreenDetails();
    stop(); complete = { A: false, B: false }; popup?.close(); $('setupConfirmed').checked = false; availability();
    const select = $('screens'); select.replaceChildren();
    screenDetails.screens.forEach((screen, index) => {
      const option = document.createElement('option'); option.value = index;
      option.textContent = `${screen.label || `Display ${index + 1}`} · ${screen.width} × ${screen.height}`;
      select.appendChild(option);
    });
    select.hidden = false;
    selectedScreen = screenDetails.screens[0];
    select.onchange = () => { stop(); complete = { A: false, B: false }; selectedScreen = screenDetails.screens[Number(select.value)]; popup?.close(); availability(); };
    screenDetails.addEventListener('screenschange', () => { stop(); complete = { A: false, B: false }; popup?.close(); status("Screens changed. Select your 3D display and check your setup again."); $('setupConfirmed').checked = false; availability(); });
  } catch (error) { status(error.message); }
};
$('openScreen').onclick = () => {
  if (popup && !popup.closed) { popup.focus(); return; }
  const s = selectedScreen;
  popup = window.open('/study-display.html', 'sk-stereo-display', s ? `popup,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}` : 'popup,width=1280,height=720');
  if (!popup) status("The player was blocked. Allow pop-ups, then click “Open player” again.");
};
$('playA').onclick = () => play('A');
$('playB').onclick = () => play('B');
$('setupConfirmed').onchange = () => { if (!$('setupConfirmed').checked) { stop(); complete = { A: false, B: false }; } availability(); };
for (const button of document.querySelectorAll('[data-choice]')) button.onclick = async () => {
  if (button.disabled || busy) return;
  busy = true; stop(); availability();
  try {
    await api('respond', { session_id: sessionId, trial_id: trial.trial_id, choice: button.dataset.choice, playback_complete: complete.A && complete.B });
    await next();
  } catch (error) { status(error.message); }
  finally { busy = false; availability(); }
};
window.addEventListener('pagehide', () => { stop(); popup?.close(); for (const url of Object.values(urls)) URL.revokeObjectURL(url); });

async function init() {
  try {
    config = await api('config');
    $('question').textContent = config.question;
    $('setupInstructions').textContent = config.setup_instructions;
    $('fixture').textContent = config.fixture ? "Test data only." : '';
    if (!token) throw new Error("Open the link from your study organizer.");
    const session = await api('session', {}); sessionId = session.session_id;
    $('setup').hidden = false;
    await next();
  } catch (error) { status(error.message); }
}
init();
