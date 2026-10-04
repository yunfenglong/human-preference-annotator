// Render one control state into both SBS eye panels. The video stays outside
// this tree and keeps its existing fullscreen geometry and playback behavior.
(() => {
  const left = document.getElementById('controlsLeft');
  const right = document.getElementById('controlsRight');
  const sourceContent = left.querySelector('.control-content');
  const copyContent = sourceContent.cloneNode(true);
  const pairs = [];
  const sources = Array.from(sourceContent.querySelectorAll('*'));
  for (const [index, copy] of Array.from(copyContent.querySelectorAll('*')).entries()) {
    const source = sources[index];
    if (copy.id) copy.id = `right-eye-${copy.id}`;
    if (copy.hasAttribute('for')) copy.setAttribute('for', `right-eye-${copy.getAttribute('for')}`);
    copy.removeAttribute('onclick');
    pairs.push([source, copy]);
    if (copy.tagName === 'BUTTON') {
      copy.onclick = () => source.click();
    } else if (copy.tagName === 'INPUT' || copy.tagName === 'SELECT') {
      copy.onchange = () => {
        if (copy.type === 'checkbox') source.checked = copy.checked;
        else source.value = copy.value;
        source.dispatchEvent(new Event('change', { bubbles: true }));
      };
    }
    if (['BUTTON', 'INPUT', 'SELECT'].includes(copy.tagName)) {
      for (const node of [source, copy]) {
        node.addEventListener('pointerenter', () => { for (const eye of [source, copy]) eye.toggleAttribute('data-hovered', true); });
        node.addEventListener('pointerleave', () => { for (const eye of [source, copy]) eye.removeAttribute('data-hovered'); });
        node.addEventListener('focus', () => { for (const eye of [source, copy]) eye.toggleAttribute('data-focused', node.matches(':focus-visible')); });
        node.addEventListener('blur', () => { for (const eye of [source, copy]) eye.removeAttribute('data-focused'); });
      }
    }
    // Announce status once while retaining identical visible text in both eyes.
    if (copy.getAttribute('role') === 'status') {
      copy.setAttribute('aria-live', 'off'); copy.setAttribute('role', 'none');
    }
  }
  right.appendChild(copyContent);
  const bodies = [sourceContent, copyContent].map(content => content.querySelector('.control-body'));
  for (const [index, body] of bodies.entries()) body.addEventListener('scroll', () => {
    if (bodies[1 - index].scrollTop !== body.scrollTop) bodies[1 - index].scrollTop = body.scrollTop;
  });
  function sync() {
    for (const [source, copy] of pairs) {
      copy.hidden = source.hidden;
      if (source.tagName === 'SELECT' && copy.innerHTML !== source.innerHTML) {
        copy.replaceChildren(...Array.from(source.options, option => option.cloneNode(true)));
      } else if (!source.children.length && copy.textContent !== source.textContent) {
        copy.textContent = source.textContent;
      }
      if ('disabled' in source) copy.disabled = source.disabled;
      if ('checked' in source) copy.checked = source.checked;
      if ('value' in source) copy.value = source.value;
    }
  }
  function size() {
    const width = left.getBoundingClientRect().width;
    if (width > 0) {
      const scale = String(width / 1280);
      for (const content of [sourceContent, copyContent]) content.style.setProperty('--control-scale', scale);
    }
  }
  new ResizeObserver(size).observe(left);
  window.studyControls = { sync };
  sync(); size();
})();
