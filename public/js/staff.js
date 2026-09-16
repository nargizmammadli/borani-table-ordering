// Shared start-up for staff screens: PIN login, "start screen" tap (needed for sound), live connection.
(function () {
  const { t, esc, icon, api } = B;

  function pinPad(role, root, onDone) {
    let pin = '';
    let error = '';
    const paint = () => {
      root.innerHTML = `
        <div class="gate">
          <div class="gate-card">
            <img src="/img/logo.jpg" alt="" width="82" height="82" class="gate-logo" />
            <h1>${esc(t(role))}</h1>
            <p>${esc(t('enter_pin'))}</p>
            <div class="pin-dots" aria-live="polite">${[0, 1, 2, 3].map((i) => `<span class="${i < pin.length ? 'on' : ''}"></span>`).join('')}</div>
            <div class="pin-error" role="alert">${esc(error)}</div>
            <div class="pin-keys">
              ${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']
                .map((k) => `<button type="button" data-key="${k}" class="${/\d/.test(k) ? '' : 'muted'}">${k}</button>`)
                .join('')}
            </div>
            <div class="gate-lang">${B.langSwitch()}</div>
          </div>
        </div>`;
    };
    const press = async (k) => {
      error = '';
      if (k === 'C') pin = '';
      else if (k === '⌫' || k === 'Backspace') pin = pin.slice(0, -1);
      else if (/^\d$/.test(k) && pin.length < 8) pin += k;
      paint();
      if (pin.length === 4) {
        try {
          await api('POST', '/api/login', { role, pin });
          cleanup();
          onDone();
        } catch (err) {
          pin = '';
          error = t(err.code === 'too_many_attempts' ? 'too_many_attempts' : 'wrong_pin');
          paint();
        }
      }
    };
    const onClick = (e) => {
      const b = e.target.closest('[data-key]');
      if (b) press(b.dataset.key);
    };
    const onKey = (e) => {
      if (/^\d$/.test(e.key) || e.key === 'Backspace') press(e.key);
    };
    const onLang = () => paint();
    const cleanup = () => {
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('langchange', onLang);
    };
    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('langchange', onLang);
    paint();
  }

  function startGate(role, root, onStart) {
    const paint = () => {
      root.innerHTML = `
        <div class="gate">
          <button type="button" class="gate-card gate-start" data-start>
            <img src="/img/logo.jpg" alt="" width="82" height="82" class="gate-logo" />
            <h1>${esc(t(role))}</h1>
            <span class="btn btn-go btn-lg">${icon('volume', 26)} ${esc(t('start_screen'))}</span>
            <p>${esc(t('start_hint'))}</p>
          </button>
        </div>`;
    };
    const onLang = () => paint();
    window.addEventListener('langchange', onLang);
    root.addEventListener(
      'click',
      function handler(e) {
        if (!e.target.closest('[data-start]')) return;
        root.removeEventListener('click', handler);
        window.removeEventListener('langchange', onLang);
        B.unlockAudio();
        B.keepAwake();
        root.innerHTML = '';
        onStart();
      }
    );
    paint();
  }

  function connect(role, { onState, onDing }) {
    const socket = io({ transports: ['websocket', 'polling'] });
    const banner = document.getElementById('offline');
    let offlineTimer = null;
    socket.on('connect', () => {
      clearTimeout(offlineTimer);
      if (banner) banner.hidden = true;
      socket.emit('join', { type: role }, (res) => {
        if (res && res.ok) onState(res.state);
        else if (res && res.error === 'login_required') location.reload();
      });
    });
    socket.on('disconnect', () => {
      offlineTimer = setTimeout(() => {
        if (banner) {
          banner.textContent = t('offline');
          banner.hidden = false;
        }
      }, 2500);
    });
    socket.on('state', onState);
    socket.on('ding', (msg) => onDing && onDing(msg));
    return socket;
  }

  async function boot(role, handlers) {
    const gate = document.getElementById('gate');
    const go = () => startGate(role, gate, () => {
      document.body.classList.add('started');
      handlers.onStart && handlers.onStart();
      connect(role, handlers);
    });
    let me = { role: null };
    try {
      me = await api('GET', '/api/me');
    } catch {
      /* treat as logged out */
    }
    const allowed = me.role === role || (me.role === 'reception' && role === 'kitchen');
    if (allowed) go();
    else pinPad(role, gate, go);
  }

  async function logout() {
    await api('POST', '/api/logout').catch(() => {});
    location.reload();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  }

  window.Staff = { boot, logout, toggleFullscreen };
})();
