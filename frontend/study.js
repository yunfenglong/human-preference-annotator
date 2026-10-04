const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const metaQuest = /\bOculusBrowser\//i.test(navigator.userAgent) && /\bQuest(?:\s|;|\))/i.test(navigator.userAgent);
const stage = $('stage'), video = $('video');
let config, sessionId, trial, screenDetails, selectedScreen;
let urls = {}, complete = { A: false, B: false }, busy = false, ready = false, run = null;
let generation = 0, playbackGeneration = 0, fullscreenPending = false, xrSession = null;
const matchedQuestFrameRateSessions = new WeakSet();
const questWindows = new WeakMap();
const QUEST_WINDOW_WIDTH = 1.8;
const QUEST_WINDOW_DISTANCE = 2;
const windowSettings = { distance: 2, height: 0, size: 100 };
const windowInputs = ['windowDistance', 'windowHeight', 'windowSize'];
const status = message => { $('status').textContent = message; window.studyControls?.sync(); };
const deadline = (promise, message, milliseconds = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), milliseconds);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

async function api(path, data) {
  const response = await fetch(`/api/study/${path}`, data ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...data }),
  } : {});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed. Try again.');
  return body;
}
function fullscreen() { return metaQuest ? !!xrSession : document.fullscreenElement === stage; }
function availability() {
  const setup = $('setupConfirmed').checked;
  $('playA').disabled = busy || fullscreenPending || !ready || !setup;
  $('playB').disabled = busy || fullscreenPending || !ready || !setup || !complete.A;
  $('openScreen').disabled = fullscreenPending;
  $('openScreen').hidden = fullscreen();
  $('exitFullscreen').hidden = !fullscreen();
  if (metaQuest) windowInputs.forEach(id => { $(id).disabled = busy || fullscreenPending || fullscreen(); });
  document.querySelectorAll('#buttons [data-choice]').forEach(button => {
    button.disabled = busy || fullscreenPending || !trial || !setup || (['A', 'B', 'tie'].includes(button.dataset.choice) && !(complete.A && complete.B));
  });
  window.studyControls?.sync();
}
function videoQuality() {
  try { return video.getVideoPlaybackQuality?.() || null; } catch (_) { return null; }
}
function playbackReport() {
  if (!metaQuest || !run?.started) return;
  const quality = videoQuality(), baseline = run.quality;
  const frames = quality && baseline
    ? `${Math.max(0, quality.droppedVideoFrames - baseline.droppedVideoFrames)} / ${Math.max(0, quality.totalVideoFrames - baseline.totalVideoFrames)}`
    : 'Unavailable';
  const screen = questWindows.get(xrSession);
  const rate = xrSession?.frameRate;
  $('playbackCheckText').textContent = `${run.side}: source ${parseFrameRate(trial?.task?.video?.fps) ?? 'unknown'} fps · Headset ${rate ? `${rate} Hz` : 'unavailable'}${screen?.rateNote ? ` (${screen.rateNote})` : ''}\nVideo dropped / total frames: ${frames} · Waiting events: ${run.waits}\nHeadset refresh does not add new video frames. These counters do not measure headset compositor frame drops.`;
  $('playbackCheck').hidden = false;
}
function stop() { ++playbackGeneration; playbackReport(); video.pause(); run = null; }
function restoreControls() {
  video.hidden = true;
  $('app').hidden = false;
  stage.dataset.playing = 'false';
}
function showControls() {
  restoreControls();
  if (metaQuest && xrSession) {
    const session = xrSession;
    questWindows.get(session)?.cancelStart?.(new Error('Immersive playback closed before it was ready.'));
    xrSession = null;
    session.end().catch(error => status(error.message));
  }
}
function watchQuestSession(session) {
  session.addEventListener('end', () => {
    questWindows.get(session)?.cancelStart?.(new Error('Immersive playback closed before it was ready.'));
    if (xrSession !== session) return;
    const interrupted = !!run || fullscreenPending;
    stop(); restoreControls();
    xrSession = null;
    if (interrupted) status('Immersive playback closed. Play this video again.');
    availability();
  }, { once: true });
}
function parseFrameRate(value) {
  const [numerator, denominator = 1] = String(value ?? '').trim().split('/').map(Number);
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
function chooseQuestFrameRate(supportedFrameRates, sourceFrameRate) {
  const fps = parseFrameRate(sourceFrameRate);
  if (!fps) return null;
  const rates = Array.from(supportedFrameRates || [], Number).filter(rate => Number.isFinite(rate) && rate > 0);
  if (!rates.length) return null;
  return rates.sort((a, b) => {
    const aError = Math.abs(a / fps - Math.round(a / fps));
    const bError = Math.abs(b / fps - Math.round(b / fps));
    return Math.abs(aError - bError) > 1e-6 ? aError - bError : a - b;
  })[0];
}
async function matchQuestFrameRate(session) {
  const screen = questWindows.get(session);
  if (typeof session.updateTargetFrameRate !== 'function') { screen.rateNote = 'refresh control unavailable'; return; }
  const target = chooseQuestFrameRate(session.supportedFrameRates, trial?.task?.video?.fps);
  if (target === null || Math.abs((session.frameRate ?? -1) - target) < 0.01) return;
  try { await session.updateTargetFrameRate(target); }
  catch (_) { screen.rateNote = `request for ${target} Hz unavailable`; }
}
function renderQuestFrame(_time, frame) {
  if (xrSession !== frame.session) return;
  const screen = questWindows.get(frame.session);
  if (screen && !screen.placed) {
    const pose = frame.getViewerPose?.(screen.space);
    if (pose) {
      const matrix = pose.transform.matrix;
      screen.layer.transform = new window.XRRigidTransform({
        x: matrix[12] - screen.settings.distance * matrix[8],
        y: matrix[13] - screen.settings.distance * matrix[9] + screen.settings.height,
        z: matrix[14] - screen.settings.distance * matrix[10],
      }, pose.transform.orientation);
      screen.placed = true;
    }
  }
  frame.session.requestAnimationFrame(renderQuestFrame);
  if (!matchedQuestFrameRateSessions.has(frame.session)) {
    matchedQuestFrameRateSessions.add(frame.session);
    screen.rateReady = matchQuestFrameRate(frame.session);
  }
  if (screen?.placed && screen.startReady) {
    const resolve = screen.startReady;
    screen.startReady = null;
    screen.rateReady.then(resolve);
  }
}
async function enterFullscreen(metadata) {
  if (fullscreen()) return;
  fullscreenPending = true; availability();
  try {
    if (metaQuest) {
      if (!navigator.xr?.requestSession || typeof window.XRMediaBinding !== 'function') {
        throw new Error('This Meta Quest Browser does not support WebXR Media Layers.');
      }
      let session;
      try {
        session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['layers'] });
        await deadline(metadata, 'Video didn’t load. Exit immersive mode and try again.');
        checkVideoDimensions();
        const space = await session.requestReferenceSpace('local');
        const media = new window.XRMediaBinding(session);
        if (typeof media.createQuadLayer !== 'function') throw new Error('This Meta Quest Browser does not support flat stereo video layers.');
        // A normal SBS video belongs on a flat stereo screen, not a panorama.
        // Fit the entire per-eye frame and keep its original aspect ratio.
        const settings = { ...windowSettings };
        // Size is angular: changing distance alone keeps the whole frame in view.
        const width = QUEST_WINDOW_WIDTH * settings.distance / QUEST_WINDOW_DISTANCE * settings.size / 100;
        const layer = media.createQuadLayer(video, {
          space,
          layout: 'stereo-left-right',
          width,
          height: width / (video.videoWidth / 2 / video.videoHeight),
          transform: new window.XRRigidTransform({ y: settings.height, z: -settings.distance }),
        });
        const screen = { layer, space, settings, placed: false };
        screen.started = new Promise((resolve, reject) => { screen.startReady = resolve; screen.cancelStart = reject; });
        questWindows.set(session, screen);
        session.updateRenderState({ layers: [layer] });
      } catch (error) {
        session?.end().catch(() => {});
        throw error;
      }
      xrSession = session;
      watchQuestSession(session);
      session.requestAnimationFrame(renderQuestFrame);
      try {
        await deadline(questWindows.get(session).started, 'Headset tracking did not become ready. Try again.', 5000);
      } catch (error) {
        if (xrSession === session) { xrSession = null; await session.end().catch(() => {}); }
        throw error;
      }
    } else {
      if (!stage.requestFullscreen) throw new Error('This browser does not support fullscreen.');
      await deadline(stage.requestFullscreen(selectedScreen ? { screen: selectedScreen, navigationUI: 'hide' } : { navigationUI: 'hide' }), 'Fullscreen did not open. Click Enter fullscreen to try again.');
    }
    if (!fullscreen()) throw new Error('Fullscreen closed before playback started.');
  } catch (error) { throw new Error(`${metaQuest ? 'Couldn’t enter immersive playback.' : 'Couldn’t enter fullscreen.'} ${error.message}`); }
  finally { fullscreenPending = false; availability(); }
}

async function next() {
  const version = ++generation;
  busy = true; ready = false; trial = null; stop(); showControls();
  complete = { A: false, B: false };
  $('playbackCheck').hidden = true;
  video.removeAttribute('src'); video.load();
  for (const url of Object.values(urls)) URL.revokeObjectURL(url);
  urls = {};
  availability();
  try {
    trial = await api('next', { session_id: sessionId });
    if (!trial) { status("You're done. Thanks for taking part."); $('progress').textContent = 'Complete'; $('judgment').hidden = true; return; }
    $('progress').textContent = `${trial.progress.completed} / ${trial.progress.total}`;
    $('judgment').hidden = false;
    status('Loading videos…');
    const loaded = await Promise.all(['A', 'B'].map(async label => {
      const stimulus = trial.task.stimuli[label];
      const response = await fetch(stimulus.file, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Video won’t load. Choose “Video or display problem”.');
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== stimulus.sha256) throw new Error('This video can’t be played. Choose “Video or display problem”.');
      return [label, new Blob([bytes], { type: 'video/mp4' })];
    }));
    if (version !== generation) return;
    urls = Object.fromEntries(loaded.map(([label, blob]) => [label, URL.createObjectURL(blob)]));
    ready = true;
    status(fullscreen() ? 'Videos ready. Play A, then B.' : 'Videos ready. Check your setup before playing.');
  } catch (error) { status(error.message); }
  finally { if (version === generation) busy = false; availability(); }
}

function checkVideoDimensions() {
  const geometry = trial.task.video;
  if (video.videoWidth !== geometry.eye_width * 2 || video.videoHeight !== geometry.eye_height) throw new Error('This video has the wrong size. Choose “Video or display problem”.');
}
function checkGeometry() {
  checkVideoDimensions();
  const geometry = trial.task.video;
  const ratio = window.devicePixelRatio || 1;
  // One encoded pixel per physical display pixel. Center unchanged SBS bytes.
  const width = geometry.eye_width * 2 / ratio;
  const height = geometry.eye_height / ratio;
  if (window.innerWidth + 0.1 < width || window.innerHeight + 0.1 < height || (window.visualViewport?.scale || 1) !== 1) {
    throw new Error('The video won’t fit this screen at full resolution. Choose “Video or display problem”.');
  }
  video.style.width = `${width}px`; video.style.height = `${height}px`;
}

async function play(label) {
  if (!$('setupConfirmed').checked) { status('Confirm your setup before playing.'); return; }
  if (busy || fullscreenPending || !ready || !trial) return;
  if (label === 'B' && !complete.A) { status('Watch A to the end before playing B.'); return; }
  busy = true; stop(); availability();
  const version = generation, playbackVersion = playbackGeneration;
  const current = () => version === generation && playbackVersion === playbackGeneration && fullscreen();
  try {
    let metadata;
    if (metaQuest) {
      video.src = urls[label]; video.controls = false;
      video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'contain';
      video.hidden = false; $('app').hidden = true; stage.dataset.playing = 'true';
      metadata = new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('Video won’t play. Choose “Video or display problem”.'));
        video.load();
      });
    }
    await enterFullscreen(metadata);
    if (!current()) return;
    video.loop = false; video.controls = false; video.playbackRate = 1;
    if (!metaQuest) {
      video.src = urls[label];
      metadata = new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('Video won’t play. Choose “Video or display problem”.'));
        video.load();
      });
    }
    await deadline(metadata, 'Video didn’t load. Click Play to try again.');
    if (!current()) return;
    if (!metaQuest && document.hidden) throw new Error('Return to this window and play the video again.');
    if (!metaQuest) checkGeometry();
    video.currentTime = 0;
    run = { side: label, valid: true, started: false, quality: videoQuality(), waits: 0 };
    video.hidden = false; $('app').hidden = true; stage.dataset.playing = 'true';
    await deadline(video.play(), 'Video didn’t start. Click Play to try again.');
    if (current()) status(`Playing ${label}. Watch to the end.`);
  } catch (error) {
    if (version === generation && playbackVersion === playbackGeneration) { stop(); showControls(); status(error.message); }
  } finally { if (version === generation) busy = false; availability(); }
}

video.addEventListener('playing', () => {
  if (!run || !fullscreen() || video.playbackRate !== 1) { video.pause(); return; }
  if (!run.started) { run.started = video.currentTime < 0.25; if (!run.started) run.valid = false; }
});
video.addEventListener('seeking', () => { if (run?.started) run.valid = false; });
video.addEventListener('ratechange', () => { if (run && video.playbackRate !== 1) run.valid = false; });
video.addEventListener('waiting', () => { if (run?.started) run.waits++; });
video.addEventListener('timeupdate', () => {
  if (run && (!fullscreen() || (!metaQuest && document.hidden))) { stop(); showControls(); status('Playback interrupted. Play this video again.'); availability(); }
});
video.addEventListener('ended', () => {
  if (run?.valid && run.started && fullscreen()) {
    complete[run.side] = true;
    status(complete.B ? 'A and B finished. Choose an answer or replay either.' : 'A finished. Play B next.');
  } else { status('Playback stopped early. Play this video again.'); }
  playbackReport(); run = null; showControls(); availability();
});
video.addEventListener('error', () => {
  if (trial) { stop(); showControls(); status('Video stopped playing. Choose “Video or display problem”.'); availability(); }
});
document.addEventListener('fullscreenchange', () => {
  if (metaQuest) return;
  if (!fullscreen()) {
    const interrupted = !!run;
    stop(); showControls();
    if (interrupted) status('Fullscreen closed. Play this video again.');
  }
  availability();
});
document.addEventListener('visibilitychange', () => {
  if (!metaQuest && document.hidden && run) { stop(); showControls(); status('Playback interrupted. Play this video again.'); availability(); }
});
window.addEventListener('resize', () => {
  if (metaQuest || !fullscreen() || !run || !trial || !video.videoWidth) return;
  try { checkGeometry(); } catch (error) { stop(); showControls(); status(error.message); availability(); }
});
window.addEventListener('keydown', event => {
  if (event.repeat || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return;
  if (event.key === '1' || event.key === '2') { event.preventDefault(); play(event.key === '1' ? 'A' : 'B'); }
});

$('chooseScreen').onclick = async () => {
  try {
    if (!window.getScreenDetails) throw new Error('This browser can’t select a screen. Move this window to your 3D display before entering fullscreen.');
    screenDetails = await window.getScreenDetails();
    const select = $('screens'); select.replaceChildren();
    screenDetails.screens.forEach((screen, index) => {
      const option = document.createElement('option'); option.value = index;
      option.textContent = `${screen.label || `Display ${index + 1}`} · ${screen.width} × ${screen.height}`;
      select.appendChild(option);
    });
    selectedScreen = screenDetails.currentScreen || screenDetails.screens[0];
    select.value = screenDetails.screens.indexOf(selectedScreen); select.hidden = false;
    const resetScreen = async () => {
      stop(); showControls(); complete = { A: false, B: false }; $('setupConfirmed').checked = false;
      if (fullscreen()) await document.exitFullscreen();
      status('Screen changed. Check your setup again before playing.'); availability();
    };
    select.onchange = async () => { selectedScreen = screenDetails.screens[Number(select.value)]; await resetScreen(); };
    screenDetails.addEventListener('screenschange', resetScreen);
    availability();
  } catch (error) { status(error.message); }
};
$('openScreen').onclick = async () => {
  if (fullscreenPending) return;
  if (metaQuest) { await play(complete.A ? 'B' : 'A'); return; }
  try {
    await enterFullscreen();
    status(!$('setupConfirmed').checked ? 'Confirm your setup before playing.' : ready ? 'Fullscreen ready. Play A, then B.' : $('status').textContent);
  } catch (error) { showControls(); status(error.message); }
};
$('exitFullscreen').onclick = () => metaQuest ? xrSession?.end() : document.exitFullscreen();
$('playA').onclick = () => play('A');
$('playB').onclick = () => play('B');
function syncWindowSettings() {
  $('windowDistanceValue').textContent = `${windowSettings.distance.toFixed(1)} m`;
  $('windowHeightValue').textContent = `${windowSettings.height > 0 ? '+' : ''}${windowSettings.height.toFixed(1)} m`;
  $('windowSizeValue').textContent = `${windowSettings.size}%`;
}
for (const [id, key, min, max] of [['windowDistance', 'distance', 1, 4], ['windowHeight', 'height', -0.8, 0.8], ['windowSize', 'size', 60, 120]]) {
  $(id).oninput = () => {
    if (!metaQuest || busy || fullscreenPending || fullscreen()) { $(id).value = windowSettings[key]; return; }
    const value = Number($(id).value);
    const nextValue = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : windowSettings[key];
    $(id).value = nextValue;
    if (windowSettings[key] === nextValue) return;
    windowSettings[key] = nextValue;
    complete = { A: false, B: false };
    $('playbackCheck').hidden = true;
    syncWindowSettings();
    status('Window adjusted. Watch A and B again using this setup.'); availability();
  };
}
$('setupConfirmed').onchange = () => {
  if (!$('setupConfirmed').checked) { stop(); showControls(); complete = { A: false, B: false }; status('Confirm your setup before playing.'); }
  else if (ready) status('Setup confirmed. Play A, then B.');
  availability();
};
for (const button of document.querySelectorAll('#buttons [data-choice]')) button.onclick = async () => {
  if (button.disabled || busy) return;
  busy = true; stop(); showControls(); availability();
  try {
    await api('respond', { session_id: sessionId, trial_id: trial.trial_id, choice: button.dataset.choice, playback_complete: complete.A && complete.B });
    await next();
  } catch (error) { status(error.message); }
  finally { busy = false; availability(); }
};
window.addEventListener('pagehide', () => {
  stop();
  const session = xrSession; xrSession = null; session?.end().catch(() => {});
  for (const url of Object.values(urls)) URL.revokeObjectURL(url);
});

async function init() {
  try {
    config = await api('config');
    $('question').textContent = config.question;
    $('setupInstructions').textContent = config.setup_instructions;
    if (metaQuest) {
      $('setupInstructions').textContent += '\nMeta Quest shows the complete video on a flat stereoscopic window in front of you. Face forward when starting playback; left and right eyes receive their respective SBS images.';
      $('chooseScreen').hidden = true;
      $('openScreen').textContent = 'Open stereo video window';
      $('questWindowSettings').hidden = false;
      syncWindowSettings();
    }
    $('fixture').textContent = config.fixture ? 'Test data only.' : '';
    if (!token) throw new Error('Open the link from your study organizer.');
    const session = await api('session', {}); sessionId = session.session_id;
    $('setup').hidden = false;
    await next();
  } catch (error) { status(error.message); }
}
init();
