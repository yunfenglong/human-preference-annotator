if (window.opener && !window.opener.closed) {
  try { window.opener.connectStudyDisplay(window); }
  catch { document.getElementById('message').textContent = 'Reopen the player from the study page.'; }
}
