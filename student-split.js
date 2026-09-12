// SNT Homework — responsive student split-screen enhancement
// Additive DOM enhancement only. Existing login, data, submissions and RPCs stay untouched.

(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  let observer = null;
  let dragState = null;

  function splitShell() {
    return $('.snt-student-split-shell');
  }

  function isStudentVisible() {
    const screen = document.getElementById('studentScreen');
    return !!screen && !screen.classList.contains('hidden');
  }

  function safeUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  function makeHeader(label, paneName) {
    const head = document.createElement('div');
    head.className = 'snt-split-head no-print';
    head.innerHTML = `
      <strong>${label}</strong>
      <div class="btn-row">
        <button type="button" class="btn btn-ghost btn-sm snt-split-mode-btn" data-maximise="${paneName}">${paneName === 'top' ? 'Maximise worksheet' : 'Maximise answers'}</button>
        <button type="button" class="btn btn-ghost btn-sm snt-split-return" data-return-split>↕ Split view</button>
      </div>`;
    return head;
  }

  function enhanceCurrentTask() {
    if (!isStudentVisible()) return;
    const taskPanel = document.getElementById('studentTaskPanel');
    if (!taskPanel) return;
    const detail = $('.task-detail', taskPanel);
    if (!detail || detail.dataset.sntSplit === '1') return;

    const hr = [...detail.children].find(el => el.tagName === 'HR');
    if (!hr) return; // selected task not fully rendered yet

    const shell = document.createElement('div');
    shell.className = 'snt-student-split-shell';
    shell.style.setProperty('--snt-split-top', localStorage.getItem('sntStudentSplitTop') || '55%');

    const top = document.createElement('section');
    top.className = 'snt-split-pane snt-split-top';
    top.appendChild(makeHeader('Worksheet / PDF / website', 'top'));
    const topScroll = document.createElement('div');
    topScroll.className = 'snt-split-scroll';
    const topContent = document.createElement('div');
    topContent.className = 'snt-task-original-content';
    topScroll.appendChild(topContent);
    top.appendChild(topScroll);

    const divider = document.createElement('div');
    divider.className = 'snt-split-divider no-print';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'horizontal');
    divider.innerHTML = '<span>↕ DRAG TO RESIZE ↕</span>';

    const bottom = document.createElement('section');
    bottom.className = 'snt-split-pane snt-split-bottom';
    bottom.appendChild(makeHeader('Your answer / submission', 'bottom'));
    const bottomScroll = document.createElement('div');
    bottomScroll.className = 'snt-split-scroll';
    const bottomContent = document.createElement('div');
    bottomContent.className = 'snt-answer-original-content';
    bottomScroll.appendChild(bottomContent);
    bottom.appendChild(bottomScroll);

    const before = [];
    const after = [];
    let seenHr = false;
    [...detail.childNodes].forEach(node => {
      if (node === hr) { seenHr = true; return; }
      (seenHr ? after : before).push(node);
    });

    before.forEach(n => topContent.appendChild(n));
    after.forEach(n => bottomContent.appendChild(n));

    detail.replaceChildren(shell);
    detail.dataset.sntSplit = '1';
    shell.append(top, divider, bottom);

    wireShell(shell, divider);
    enhanceTaskLinks(topContent);
  }

  function wireShell(shell, divider) {
    shell.addEventListener('click', evt => {
      const max = evt.target.closest('[data-maximise]');
      if (max) {
        const pane = max.dataset.maximise;
        shell.classList.toggle('show-top-only', pane === 'top');
        shell.classList.toggle('show-bottom-only', pane === 'bottom');
        return;
      }
      if (evt.target.closest('[data-return-split]')) {
        shell.classList.remove('show-top-only', 'show-bottom-only');
      }
    });

    divider.addEventListener('pointerdown', evt => {
      evt.preventDefault();
      const rect = shell.getBoundingClientRect();
      dragState = { shell, rect };
      divider.classList.add('dragging');
      divider.setPointerCapture?.(evt.pointerId);
    });

    divider.addEventListener('pointermove', evt => {
      if (!dragState || dragState.shell !== shell) return;
      const { rect } = dragState;
      const dividerPx = 22;
      const usable = Math.max(1, rect.height - dividerPx);
      let pct = ((evt.clientY - rect.top) / usable) * 100;
      pct = Math.max(20, Math.min(80, pct));
      shell.style.setProperty('--snt-split-top', `${pct}%`);
      localStorage.setItem('sntStudentSplitTop', `${pct}%`);
    });

    const stop = () => {
      if (dragState?.shell === shell) dragState = null;
      divider.classList.remove('dragging');
    };
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  }

  function enhanceTaskLinks(root) {
    const cards = $$('.task-link-card', root);
    cards.forEach(card => {
      if (card.dataset.sntEmbedReady === '1') return;
      const href = safeUrl(card.getAttribute('href'));
      if (!href) return;
      card.dataset.sntEmbedReady = '1';
      card.removeAttribute('target');
      card.addEventListener('click', evt => {
        evt.preventDefault();
        openEmbeddedResource(root, href, $('strong', card)?.textContent || href);
      });
    });
  }

  function openEmbeddedResource(root, href, title) {
    $('.snt-embed-card', root)?.remove();
    const card = document.createElement('section');
    card.className = 'snt-embed-card no-print';
    card.innerHTML = `
      <div class="snt-embed-bar">
        <strong></strong>
        <div class="snt-embed-actions">
          <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer">Open externally</a>
          <button type="button" class="btn btn-ghost btn-sm" data-close-embed>Close viewer</button>
        </div>
      </div>
      <div class="snt-embed-help">The website is shown inside SNT when it allows embedding. If it blocks this, use <strong>Open externally</strong>.</div>
      <iframe class="snt-embed-frame" loading="lazy" referrerpolicy="no-referrer-when-downgrade" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-downloads"></iframe>`;
    $('strong', card).textContent = title;
    const open = $('a', card);
    open.href = href;
    const frame = $('iframe', card);
    frame.src = href;
    $('[data-close-embed]', card).addEventListener('click', () => card.remove());
    root.prepend(card);
  }

  function watch() {
    const panel = document.getElementById('studentTaskPanel');
    if (!panel) return;
    observer?.disconnect();
    observer = new MutationObserver(() => queueMicrotask(enhanceCurrentTask));
    observer.observe(panel, { childList: true, subtree: true });
    enhanceCurrentTask();
  }

  document.addEventListener('DOMContentLoaded', watch);
  window.addEventListener('load', watch);
})();
