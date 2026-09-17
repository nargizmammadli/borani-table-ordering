// Kitchen display: approved food orders, oldest first. Tap a dish when ready, or "All ready".
(function () {
  const { t, tr, esc, icon, api, toast, minutesSince, clock } = B;

  const $head = document.getElementById('head');
  const $board = document.getElementById('board');
  const $modalRoot = document.getElementById('modal-root');

  let view = { orders: [], recent: [], serverTime: Date.now() };
  let clockOffset = 0; // tablet clocks are often wrong; use server time for "minutes waiting"
  let soundOn = B.storageGet('borani-kitchen-sound', true);
  let recentOpen = false;
  let firstState = true;
  const known = new Set();
  const newUntil = new Map();
  const pending = new Set(); // lines/orders being saved, to ignore double taps

  const now = () => Date.now() + clockOffset;

  function renderHead() {
    $head.innerHTML = `
      <div class="staff-brand"><img src="/borani-table-ordering/img/logo.jpg" alt="" /> ${esc(t('kitchen'))}</div>
      <span class="k-count"><b>${view.orders.length}</b> ${esc(t('active'))}</span>
      <span class="staff-clock">${clock(now())}</span>
      <div class="staff-tools">
        <button type="button" class="tool-btn" data-recent>${icon('undo', 22)} <span class="label">${esc(t('recent'))}</span></button>
        ${B.langSwitch()}
        <button type="button" class="tool-btn" data-sound aria-pressed="${soundOn}" title="${esc(t('sound'))}">${icon(soundOn ? 'volume' : 'mute', 22)}</button>
        <button type="button" class="tool-btn" data-fullscreen title="${esc(t('fullscreen'))}">${icon('maximize', 22)}</button>
        <button type="button" class="tool-btn" data-logout title="${esc(t('logout'))}">${icon('logout', 22)}</button>
      </div>`;
  }

  function ageClass(mins) {
    if (mins >= 20) return 'age-late';
    if (mins >= 10) return 'age-warn';
    return 'age-ok';
  }

  function lineHtml(order, l) {
    const done = l.status === 'ready' || l.status === 'served';
    const cancelled = l.status === 'cancelled';
    const classes = ['k-line', done && 'done', cancelled && 'cancelled', l.change && 'changed'].filter(Boolean).join(' ');
    let badge = '';
    if (l.change === 'added') badge = `<span class="k-badge added">${esc(t('badge_new'))}</span>`;
    if (l.change === 'qty') badge = `<span class="k-badge qty">${esc(t('was_qty', { n: l.prevQty }))}</span>`;
    if (cancelled) badge = `<span class="k-badge cancelled">${esc(t('badge_cancelled'))}</span>`;
    const tags = l.quickNotes.length ? `<div class="k-tags">${l.quickNotes.map((k) => `<span class="k-tag">${esc(t(`qn_${k}`))}</span>`).join('')}</div>` : '';
    const note = l.note ? `<div class="k-line-note">${esc(l.note)}</div>` : '';
    const extra = badge || tags || note ? `<div class="k-extra">${badge}${tags}${note}</div>` : '';
    return `
      <li>
        <button type="button" class="${classes}" ${cancelled ? 'disabled' : `data-line="${esc(l.id)}" data-order="${esc(order.id)}" data-ready="${done ? 0 : 1}"`}>
          <span class="k-qty">${l.qty}</span>
          <span class="k-name">${esc(tr(l.name))}${l.variantLabel ? ` <span class="k-variant">${esc(tr(l.variantLabel))}</span>` : ''}</span>
          <span class="k-check">${icon('check', 24)}</span>
          ${extra}
        </button>
      </li>`;
  }

  function cardHtml(order) {
    const mins = minutesSince(order.approvedAt, now());
    const isNew = (newUntil.get(order.id) || 0) > Date.now();
    const anyTodo = order.lines.some((l) => l.status === 'todo');
    return `
      <article class="k-card ${ageClass(mins)}${isNew ? ' is-new' : ''}" data-card="${esc(order.id)}">
        <header class="k-card-head">
          <div class="k-table">${esc(t('table'))} <b>${esc(order.table)}</b></div>
          <div class="k-time">${icon('clock', 26)} ${mins} ${esc(t('min'))}</div>
        </header>
        <div class="k-sub">№${order.no} · ${clock(order.approvedAt)}${order.byStaff ? ` · ${esc(t('from_reception'))}` : ''}</div>
        ${
          order.alert
            ? `<div class="k-alert">${icon('alert', 26)} <span>${esc(t('changed_banner'))}</span><button type="button" data-seen="${esc(order.id)}">${esc(t('seen'))}</button></div>`
            : ''
        }
        ${order.note ? `<div class="k-note">${icon('note', 24)} <span>${esc(order.note)}</span></div>` : ''}
        <ul class="k-lines">${order.lines.map((l) => lineHtml(order, l)).join('')}</ul>
        ${
          anyTodo
            ? `<button type="button" class="k-all" data-all="${esc(order.id)}">${icon('check', 30)} ${esc(t('all_ready'))}</button>
               <div class="k-hint">${esc(t('tap_hint'))}</div>`
            : `<button type="button" class="k-all" data-all="${esc(order.id)}">${icon('check', 30)} ${esc(t('seen'))}</button>`
        }
      </article>`;
  }

  function renderBoard() {
    if (!view.orders.length) {
      $board.innerHTML = `
        <div class="k-empty">
          ${icon('menu', 72)}
          <h2>${esc(t('no_orders'))}</h2>
          <p>${esc(t('no_orders_hint'))}</p>
        </div>`;
      return;
    }
    $board.innerHTML = view.orders.map(cardHtml).join('');
  }

  function renderRecent() {
    if (!recentOpen) {
      $modalRoot.innerHTML = '';
      return;
    }
    const alreadyOpen = $modalRoot.childElementCount > 0;
    $modalRoot.innerHTML = `
      <div class="modal-backdrop${alreadyOpen ? ' static' : ''}" data-backdrop>
        <div class="modal" role="dialog" aria-modal="true">
          <button type="button" class="icon-btn modal-close" data-close-recent aria-label="${esc(t('close'))}">${icon('x', 26)}</button>
          <div class="modal-body dialog">
            <h2>${esc(t('recent'))}</h2>
            <div class="k-recent">
              ${
                view.recent.length
                  ? view.recent
                      .map(
                        (o) => `
                <div class="k-recent-row">
                  <div class="k-table">${esc(t('table'))} <b>${esc(o.table)}</b></div>
                  <div class="items">№${o.no} · ${clock(o.doneAt)}<br />${o.lines
                          .filter((l) => l.status !== 'cancelled')
                          .map((l) => `${l.qty}× ${esc(tr(l.name))}`)
                          .join(', ')}</div>
                  <button type="button" class="btn btn-outline" data-reopen="${esc(o.id)}">${icon('undo', 22)} ${esc(t('bring_back'))}</button>
                </div>`
                      )
                      .join('')
                  : `<p>${esc(t('nothing'))}</p>`
              }
            </div>
          </div>
        </div>
      </div>`;
  }

  function render() {
    renderHead();
    renderBoard();
    renderRecent();
  }

  function onState(next) {
    clockOffset = next.serverTime - Date.now();
    let arrived = false;
    for (const o of next.orders) {
      if (known.has(o.id)) continue;
      known.add(o.id);
      if (!firstState) {
        newUntil.set(o.id, Date.now() + 60_000);
        arrived = true;
      }
    }
    firstState = false;
    view = next;
    render();
    if (arrived) flash();
  }

  function flash() {
    document.title = `● ${t('kitchen')} — Boranı`;
    setTimeout(() => (document.title = `${t('kitchen')} — Boranı`), 8000);
  }

  function onDing(msg) {
    if (msg.type !== 'kitchen' || !soundOn) return;
    B.chime([660, 880, 1100], { gap: 0.18, length: 0.3, volume: 0.5 });
    setTimeout(() => B.chime([660, 880, 1100], { gap: 0.18, length: 0.3, volume: 0.5 }), 900);
  }

  async function act(key, fn) {
    if (pending.has(key)) return;
    pending.add(key);
    try {
      await fn();
    } catch (err) {
      toast(`${icon('alert', 24)} ${esc(t('error_generic'))}`, { kind: 'error' });
    } finally {
      pending.delete(key);
    }
  }

  document.addEventListener('click', (e) => {
    const el = (sel) => e.target.closest(sel);
    let m;
    if ((m = el('[data-line]'))) {
      const ready = m.dataset.ready === '1';
      m.classList.toggle('done', ready); // instant feedback, server state follows
      m.dataset.ready = ready ? '0' : '1';
      act(`line:${m.dataset.line}`, () => api('POST', `/api/orders/${m.dataset.order}/lines/${m.dataset.line}/ready`, { ready }));
    } else if ((m = el('[data-all]'))) {
      const card = m.closest('.k-card');
      if (card) card.style.opacity = '0.4';
      act(`all:${m.dataset.all}`, () => api('POST', `/api/orders/${m.dataset.all}/ready`, { station: 'kitchen' }));
    } else if ((m = el('[data-seen]'))) {
      act(`seen:${m.dataset.seen}`, () => api('POST', `/api/orders/${m.dataset.seen}/seen`));
    } else if ((m = el('[data-reopen]'))) {
      act(`reopen:${m.dataset.reopen}`, async () => {
        await api('POST', `/api/orders/${m.dataset.reopen}/reopen`);
        recentOpen = false;
        renderRecent();
      });
    } else if (el('[data-recent]')) {
      recentOpen = true;
      renderRecent();
    } else if (el('[data-close-recent]') || e.target.matches('[data-backdrop]')) {
      recentOpen = false;
      renderRecent();
    } else if (el('[data-sound]')) {
      soundOn = !soundOn;
      B.storageSet('borani-kitchen-sound', soundOn);
      if (soundOn) B.chime([880]);
      renderHead();
    } else if (el('[data-fullscreen]')) {
      Staff.toggleFullscreen();
    } else if (el('[data-logout]')) {
      Staff.logout();
    }
  });

  window.addEventListener('langchange', render);

  // Keep the "minutes waiting" counters and colours current
  setInterval(() => {
    if (document.body.classList.contains('started')) {
      renderHead();
      renderBoard();
    }
  }, 20_000);

  Staff.boot('kitchen', { onState, onDing });
})();
