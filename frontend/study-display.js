const begin = document.getElementById('begin');
const stage = document.getElementById('stage');
const message = document.getElementById('message');
try {
  if (!window.opener || window.opener.closed || !window.opener.connectStudyDisplay(window)) throw new Error('Disconnected');
  begin.onclick = async () => {
    if (begin.disabled) return;
    window.enteringStudyFullscreen = true;
    begin.disabled = true;
    const playback = window.prepareStudyPlayback();
    try {
      if (document.fullscreenElement !== stage) {
        if (!stage.requestFullscreen) throw new Error('This browser does not support fullscreen. Use desktop Chrome.');
        // Request in the player's own click handler: activation does not transfer
        // from the controller window to this window in Chrome.
        const request = stage.requestFullscreen(window.studyFullscreenOptions);
        let timer;
        try {
          await Promise.race([request, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Fullscreen did not open. Try again in the player window.')), 15000);
          })]);
        } finally { clearTimeout(timer); }
      }
      if (document.fullscreenElement === stage) await window.startStudyPlayback(playback);
    } catch (error) {
      window.reportStudyDisplayError(`Couldn’t enter fullscreen. ${error.message}`);
    } finally {
      window.enteringStudyFullscreen = false;
      window.refreshStudyDisplay();
    }
  };
} catch {
  begin.disabled = true;
  message.textContent = 'Reopen the player using “Open player” on the study page.';
}
