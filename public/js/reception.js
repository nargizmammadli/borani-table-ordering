// Reception / cashier screen: approve orders, handle calls, prepare drinks & desserts,
// edit table orders (until an item is ready), close bills, sold-out switches, QR codes.
(function () {
  const { t, tr, esc, icon, api, toast, money, clock, ago, minutesSince, storageGet, storageSet } = B;

  const $head = document.getElementById('head');
  const $main = document.getElementById('main');
  const $layerTable = document.getElementById('layer-table');
  const $layerPicker = document.getElementById('layer-picker');
  const $layerConfirm = document.getElementById('layer-confirm');

  let menu = null;
  let itemsById = new Map();
  let view = { settings: { tableCount: 0 }, tables: [], orders: [], calls: [], soldOut: [], serverTime: Date.now() };
  let clockOffset = 0;
  let tab = storageGet('borani-reception-tab', 'live');
  let soundOn = storageGet('borani-reception-sound', true);
  let openTable = null;
  let picker = null;
  let confirmBox = null;
  let menuSearch = '';
  let qrList = null;
  const busy = new Set();

  const now = () => Date.now() + clockOffset;
  const soldOut = () => new Set(view.soldOut);
  const pct = () => (menu ? menu.restaurant.serviceChargePercent : 10);

  // ---------- shared bits ----------

  const stationIcon = (station) =>
    `<span class="r-station" title="${esc(t(station === 'kitchen' ? 'station_kitchen' : 'station_bar'))}">${icon(station === 'kitchen' ? 'menu' : 'cup', 18)}</span>`;

  const tags = (keys) =>
    keys && keys.length ? `<div class="note-tags">${keys.map((k) => `<span class="note-tag">${esc(t(`qn_${k}`))}</span>`).join('')}</div>` : '';

  const orderSubtotal = (o) => o.lines.filter((l) => l.status !== 'cancelled').reduce((s, l) => s + l.price * l.qty, 0);

  const lineLabel = (l) => `${esc(tr(l.name))}${l.variantLabel ? ` <small>${esc(tr(l.variantLabel))}</small>` : ''}`;

  function linePill(order, l) {
    if (l.status === 'cancelled') return `<span class="pill pill-grey">${icon('x', 16)} ${esc(t('status_cancelled'))}</span>`;
    if (order.status === 'pending') return `<span class="pill pill-amber">${icon('clock', 16)} ${esc(t('status_pending'))}</span>`;
    if (order.status === 'rejected') return `<span class="pill pill-red">${esc(t('status_rejected'))}</span>`;
    if (l.status === 'served') return `<span class="pill pill-grey">${icon('check', 16)} ${esc(t('status_served'))}</span>`;
    if (l.status === 'ready') return `<span class="pill pill-green">${icon('check', 16)} ${esc(t('status_ready'))}</span>`;
    return `<span class="pill pill-blue">${icon('flame', 16)} ${esc(t('status_todo'))}</span>`;
  }

  const tableBtn = (table) => `<button type="button" class="r-table-btn" data-open-table="${esc(table)}">${esc(t('table'))} ${esc(table)}</button>`;

  const ERRORS = { line_ready: 'locked', item_sold_out: 'error_item_sold_out' };

  async function act(key, fn) {
    if (busy.has(key)) return;
    busy.add(key);
    try {
      await fn();
    } catch (err) {
      toast(`${icon('alert', 24)} ${esc(t(ERRORS[err.code] || 'error_generic'))}`, { kind: 'error', ms: 4000 });
    } finally {
      busy.delete(key);
    }
  }

  // ---------- header ----------

  function renderHead() {
    const pending = view.orders.filter((o) => o.status === 'pending').length;
    const attention = pending + view.calls.length;
    document.title = `${attention ? `(${attention}) ` : ''}${t('reception')} — Boranı`;
    const tabBtn = (id, ic, label, count = 0) =>
      `<button type="button" data-tab="${id}" ${tab === id ? 'aria-current="page"' : ''}>${icon(ic, 22)} ${esc(label)}${
        count ? `<span class="count">${count}</span>` : ''
      }</button>`;
    $head.innerHTML = `
      <div class="staff-brand"><img src="/img/logo.jpg" alt="" /> ${esc(t('reception'))}</div>
      <nav class="r-tabs">
        ${tabBtn('live', 'live', t('tab_live'), attention)}
        ${tabBtn('tables', 'grid', t('tab_tables'))}
        ${tabBtn('menu', 'list', t('tab_menu'), view.soldOut.length)}
        ${tabBtn('qr', 'qr', t('tab_qr'))}
      </nav>
      <span class="staff-clock">${clock(now())}</span>
      <div class="staff-tools">
        ${B.langSwitch()}
        <button type="button" class="tool-btn" data-sound title="${esc(t('sound'))}">${icon(soundOn ? 'volume' : 'mute', 22)}</button>
        <button type="button" class="tool-btn" data-fullscreen title="${esc(t('fullscreen'))}">${icon('maximize', 22)}</button>
        <button type="button" class="tool-btn" data-logout title="${esc(t('logout'))}">${icon('logout', 22)}</button>
      </div>`;
  }

  // ---------- live tab ----------

  function colTitle(label, count, hot = false) {
    return `<h2 class="r-col-title">${esc(label)} <span class="count${hot && count ? ' hot' : ''}">${count}</span></h2>`;
  }

  const none = () => `<div class="r-none">${esc(t('nothing'))}</div>`;

  function pendingCard(o) {
    return `
      <article class="r-card r-pending">
        <header class="r-card-head">
          ${tableBtn(o.table)}
          <span class="r-meta">№${o.no} · ${esc(ago(o.createdAt))}</span>
        </header>
        ${o.note ? `<p class="r-note">${icon('note', 20)} ${esc(o.note)}</p>` : ''}
        <ul class="r-lines">
          ${o.lines
            .map(
              (l) => `
            <li class="${l.status === 'cancelled' ? 'cancelled' : ''}">
              <span class="r-qty">${l.qty}×</span>
              <span class="r-name">${lineLabel(l)}${stationIcon(l.station)}</span>
              <span class="r-price">${money(l.price * l.qty)}</span>
              ${l.quickNotes.length || l.note ? `<div class="r-extra">${tags(l.quickNotes)}${l.note ? `<div class="line-note">“${esc(l.note)}”</div>` : ''}</div>` : ''}
            </li>`
            )
            .join('')}
        </ul>
        <div class="r-card-total"><span>${esc(t('subtotal'))}</span><span>${money(orderSubtotal(o))}</span></div>
        <div class="r-actions">
          <button type="button" class="btn btn-go" data-approve="${esc(o.id)}">${icon('check', 24)} ${esc(t('approve'))}</button>
          <button type="button" class="btn btn-outline" data-open-table="${esc(o.table)}">${icon('pencil', 20)} ${esc(t('edit'))}</button>
          <button type="button" class="btn btn-outline danger" data-reject="${esc(o.id)}">${icon('x', 20)} ${esc(t('reject'))}</button>
        </div>
      </article>`;
  }

  function callCard(c) {
    const table = view.tables.find((x) => x.table === c.table);
    const bill = c.type === 'bill';
    const details = [ago(c.createdAt)];
    if (bill && c.payMethod) details.push(t(c.payMethod));
    if (bill && table) details.push(money(table.totals.total));
    return `
      <article class="r-card r-call ${bill ? 'bill' : ''}">
        <span class="r-call-icon">${icon(bill ? 'receipt' : 'bell', 26)}</span>
        <div class="r-call-text">${esc(t('table'))} ${esc(c.table)} — ${esc(t(bill ? 'call_bill_msg' : 'call_waiter_msg'))}<small>${esc(details.join(' · '))}</small></div>
        <div class="r-call-actions">
          ${bill ? `<button type="button" class="btn btn-outline btn-sm" data-open-table="${esc(c.table)}">${icon('receipt', 18)}</button>` : ''}
          <button type="button" class="btn btn-go btn-sm" data-resolve="${esc(c.id)}">${icon('check', 18)} ${esc(t('done'))}</button>
        </div>
      </article>`;
  }

  function serveCard(o) {
    const ready = o.lines.filter((l) => l.status === 'ready');
    return `
      <article class="r-card r-serve">
        <header class="r-card-head">${tableBtn(o.table)}<span class="r-meta">№${o.no}</span></header>
        <ul class="r-lines">
          ${ready.map((l) => `<li><span class="r-qty">${l.qty}×</span><span class="r-name">${lineLabel(l)}${stationIcon(l.station)}</span><span></span></li>`).join('')}
        </ul>
        <div class="r-card-foot"><button type="button" class="btn btn-go btn-block" data-served="${esc(o.id)}">${icon('check', 22)} ${esc(t('served_btn'))}</button></div>
      </article>`;
  }

  function barCard(o) {
    const lines = o.lines.filter((l) => l.station === 'bar' && (l.status === 'todo' || l.status === 'ready'));
    return `
      <article class="r-card r-bar">
        <header class="r-card-head">${tableBtn(o.table)}<span class="r-meta">№${o.no} · ${minutesSince(o.approvedAt, now())} ${esc(t('min'))}</span></header>
        ${o.note ? `<p class="r-note">${icon('note', 20)} ${esc(o.note)}</p>` : ''}
        <div class="r-tap-list">
          ${lines
            .map(
              (l) => `
            <button type="button" class="r-tap-line${l.status === 'ready' ? ' done' : ''}" data-bar-line="${esc(l.id)}" data-order="${esc(o.id)}" data-ready="${l.status === 'ready' ? 0 : 1}">
              <span class="r-qty">${l.qty}×</span>
              <span><span class="r-name">${lineLabel(l)}</span>${tags(l.quickNotes)}${l.note ? `<div class="line-note" style="font-style:italic;color:var(--ink-2)">“${esc(l.note)}”</div>` : ''}</span>
              <span class="check">${icon('check', 20)}</span>
            </button>`
            )
            .join('')}
        </div>
        <div class="r-card-foot"><button type="button" class="btn btn-primary btn-block" data-bar-all="${esc(o.id)}">${icon('check', 22)} ${esc(t('all_ready'))}</button></div>
      </article>`;
  }

  function kitchenRow(o) {
    const lines = o.lines.filter((l) => l.station === 'kitchen' && l.status !== 'cancelled');
    const done = lines.filter((l) => l.status !== 'todo').length;
    return `
      <button type="button" class="r-card r-progress" data-open-table="${esc(o.table)}">
        <span class="r-table-btn" style="font-size:17px;min-height:38px">${esc(t('table'))} ${esc(o.table)}</span>
        <span class="r-name">${done}/${lines.length} ${esc(t('status_ready').toLowerCase())}</span>
        <span class="r-meta">${icon('clock', 16)} ${minutesSince(o.approvedAt, now())} ${esc(t('min'))}</span>
      </button>`;
  }

  function renderLive() {
    const pending = view.orders.filter((o) => o.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const calls = [...view.calls].sort((a, b) => a.createdAt - b.createdAt);
    const approved = view.orders.filter((o) => o.status === 'approved');
    const toServe = approved.filter((o) => o.lines.some((l) => l.status === 'ready'));
    const bar = approved.filter((o) => o.lines.some((l) => l.station === 'bar' && l.status === 'todo')).sort((a, b) => a.approvedAt - b.approvedAt);
    const kitchen = approved.filter((o) => o.lines.some((l) => l.station === 'kitchen' && l.status === 'todo')).sort((a, b) => a.approvedAt - b.approvedAt);

    $main.innerHTML = `
      <div class="r-live">
        <section class="r-col">
          ${colTitle(t('waiting_approval'), pending.length, true)}
          ${pending.length ? pending.map(pendingCard).join('') : none()}
        </section>
        <section class="r-col">
          ${colTitle(t('calls'), calls.length, true)}
          ${calls.length ? calls.map(callCard).join('') : none()}
          ${colTitle(t('to_serve'), toServe.length)}
          ${toServe.length ? toServe.map(serveCard).join('') : none()}
        </section>
        <section class="r-col">
          ${colTitle(t('bar_queue'), bar.length)}
          ${bar.length ? bar.map(barCard).join('') : none()}
          ${colTitle(t('in_kitchen'), kitchen.length)}
          ${kitchen.length ? kitchen.map(kitchenRow).join('') : none()}
        </section>
      </div>`;
  }

  // ---------- tables tab ----------

  function renderTables() {
    $main.innerHTML = `
      <div class="r-tables">
        ${view.tables
          .map((tb) => {
            const calls = view.calls.filter((c) => c.table === tb.table);
            const open = Boolean(tb.billId);
            const attention = tb.pending > 0 || calls.length > 0;
            return `
            <button type="button" class="r-tile${open ? ' open' : ''}${attention ? ' attention' : ''}" data-open-table="${esc(tb.table)}">
              <span><span class="r-tile-label">${esc(t('table'))}</span><br /><span class="r-tile-no">${esc(tb.table)}</span></span>
              <span class="r-tile-status">${open ? money(tb.totals.total) : esc(t('free'))}</span>
              <span class="r-tile-badges">
                ${tb.pending ? `<span class="pill pill-amber">${icon('clock', 16)} ${tb.pending}</span>` : ''}
                ${calls.map((c) => `<span class="pill pill-red">${icon(c.type === 'bill' ? 'receipt' : 'bell', 16)}</span>`).join('')}
                ${tb.preparing ? `<span class="pill pill-blue">${icon('flame', 16)}</span>` : ''}
              </span>
            </button>`;
          })
          .join('')}
      </div>`;
  }

  // ---------- menu (sold out) tab ----------

  function renderMenuTab() {
    if (!document.getElementById('menu-list')) {
      $main.innerHTML = `
        <div class="r-panel">
          <p class="r-hint">${esc(t('sold_out_hint'))}</p>
          <input class="input" type="search" data-menu-search placeholder="${esc(t('search'))}" value="${esc(menuSearch)}" />
          <div id="menu-list"></div>
        </div>`;
    }
    const q = menuSearch.trim().toLowerCase();
    const out = soldOut();
    const list = document.getElementById('menu-list');
    list.innerHTML = menu.categories
      .map((c) => {
        const items = menu.items.filter(
          (i) => i.category === c.id && (!q || ['az', 'en', 'ru'].some((l) => (i.name[l] || '').toLowerCase().includes(q)))
        );
        if (!items.length) return '';
        return `
          <h3 class="r-menu-cat">${esc(tr(c.name))}</h3>
          ${items
            .map((i) => {
              const isOut = out.has(i.id);
              return `
              <div class="r-menu-row${isOut ? ' out' : ''}">
                <img src="${esc(i.image)}" alt="" loading="lazy" />
                <span class="r-name">${esc(tr(i.name))}</span>
                <span class="r-price">${money(i.price)}</span>
                <button type="button" class="btn btn-outline r-switch ${isOut ? 'off' : 'on'}" data-sold-out="${esc(i.id)}" data-value="${isOut ? 0 : 1}">
                  ${icon(isOut ? 'x' : 'check', 20)} ${esc(t(isOut ? 'sold_out' : 'available'))}
                </button>
              </div>`;
            })
            .join('')}`;
      })
      .join('');
  }

  // ---------- QR tab ----------

  async function loadQr() {
    try {
      qrList = (await api('GET', '/api/qr-codes')).tables;
    } catch {
      qrList = [];
    }
    if (tab === 'qr') renderQrTab();
  }

  function renderQrTab() {
    $main.innerHTML = `
      <div class="r-panel">
        <p class="r-hint">${esc(t('qr_hint'))}</p>
        <form class="r-qr-controls" data-table-count>
          <label><span class="field-label">${esc(t('table_count'))}</span>
            <input class="input" type="number" name="count" min="1" max="200" value="${view.settings.tableCount}" /></label>
          <button type="submit" class="btn btn-outline">${icon('check', 20)} ${esc(t('save'))}</button>
          <a class="btn btn-primary" href="/qr" target="_blank" rel="noopener">${icon('printer', 22)} ${esc(t('print_qr'))}</a>
        </form>
        <div class="r-qr-grid">
          ${
            qrList
              ? qrList
                  .map(
                    (q) => `
            <div class="r-qr-card">
              <b>${esc(t('table'))} ${esc(q.table)}</b>
              ${q.svg}
              <a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.url)}</a>
            </div>`
                  )
                  .join('')
              : ''
          }
        </div>
      </div>`;
  }

  function renderMain() {
    if (!menu) return;
    if (tab === 'tables') renderTables();
    else if (tab === 'menu') renderMenuTab();
    else if (tab === 'qr') renderQrTab();
    else renderLive();
  }

  // ---------- table modal ----------

  function renderTableLayer() {
    if (!openTable) {
      $layerTable.innerHTML = '';
      return;
    }
    const prevBody = $layerTable.querySelector('.modal-body');
    const scroll = prevBody ? prevBody.scrollTop : 0;

    const tb = view.tables.find((x) => x.table === openTable) || { table: openTable, totals: { subtotal: 0, service: 0, total: 0 } };
    const orders = view.orders.filter((o) => o.table === openTable).sort((a, b) => a.createdAt - b.createdAt);
    const calls = view.calls.filter((c) => c.table === openTable);
    const unready = orders.some((o) => o.status === 'approved' && o.lines.some((l) => l.status === 'todo'));

    const row = (o, l) => {
      const editable = o.status !== 'rejected' && l.status === 'todo';
      let qty;
      if (editable) {
        qty = `<div class="stepper small">
            <button type="button" data-line-qty="${esc(l.id)}" data-order="${esc(o.id)}" data-qty="${l.qty - 1}" aria-label="-1">${icon('minus', 20)}</button>
            <output>${l.qty}</output>
            <button type="button" data-line-qty="${esc(l.id)}" data-order="${esc(o.id)}" data-qty="${l.qty + 1}" aria-label="+1">${icon('plus', 20)}</button>
          </div>`;
      } else if (l.status === 'ready' || l.status === 'served') {
        qty = `<span class="r-lock">${icon('lock', 16)} ${l.qty}× · ${esc(t('locked'))}</span>`;
      } else {
        qty = `<span class="r-qty">${l.qty}×</span>`;
      }
      return `
        <div class="r-row${l.status === 'cancelled' ? ' cancelled' : ''}">
          ${stationIcon(l.station)}
          <div><span class="r-name">${lineLabel(l)}</span>${tags(l.quickNotes)}${
            l.note ? `<div class="line-note" style="font-style:italic;color:var(--ink-2)">“${esc(l.note)}”</div>` : ''
          }</div>
          <div class="r-row-qty">${qty}</div>
          <div class="r-row-status">${linePill(o, l)}</div>
          <span class="r-price">${money(l.price * l.qty)}</span>
          <div>${
            editable
              ? `<button type="button" class="icon-btn" style="width:44px;height:44px;color:var(--red)" data-cancel-line="${esc(l.id)}" data-order="${esc(o.id)}" aria-label="${esc(t('remove'))}">${icon('trash', 20)}</button>`
              : ''
          }</div>
        </div>`;
    };

    const statusPill = (o) =>
      o.status === 'pending'
        ? `<span class="pill pill-amber">${icon('clock', 16)} ${esc(t('status_pending'))}</span>`
        : o.status === 'rejected'
          ? `<span class="pill pill-red">${esc(t('status_rejected'))}</span>`
          : `<span class="pill pill-green">${icon('check', 16)} ${esc(t('status_approved'))}</span>`;

    $layerTable.innerHTML = `
      <div class="modal-backdrop${prevBody ? ' static' : ''}" data-close-layer="table">
        <div class="modal wide" role="dialog" aria-modal="true">
          <button type="button" class="icon-btn modal-close" data-close-layer="table" aria-label="${esc(t('close'))}">${icon('x', 26)}</button>
          <div class="modal-body dialog">
            <h2>${esc(t('table'))} ${esc(openTable)}</h2>
            <p>${tb.openedAt ? esc(t('open_since', { time: clock(tb.openedAt) })) : esc(t('free'))}</p>
            ${calls.map(callCard).join('')}
            ${orders
              .map(
                (o) => `
              <section class="r-order ${o.status}">
                <header class="r-order-head">
                  <b>№${o.no}</b><span class="r-meta">${clock(o.createdAt)}</span>
                  ${statusPill(o)}
                  ${o.byStaff ? `<span class="pill pill-grey">${esc(t('from_reception'))}</span>` : ''}
                  <span class="spacer"></span>
                  ${
                    o.status === 'pending'
                      ? `<button type="button" class="btn btn-go btn-sm" data-approve="${esc(o.id)}">${icon('check', 20)} ${esc(t('approve'))}</button>
                         <button type="button" class="btn btn-outline btn-sm danger" data-reject="${esc(o.id)}">${icon('x', 20)} ${esc(t('reject'))}</button>`
                      : ''
                  }
                </header>
                ${o.note ? `<p class="r-note">${icon('note', 20)} ${esc(o.note)}</p>` : ''}
                ${o.lines.map((l) => row(o, l)).join('')}
                ${
                  o.status !== 'rejected'
                    ? `<div class="r-order-foot"><button type="button" class="btn btn-outline btn-sm" data-add-to-order="${esc(o.id)}">${icon('plus', 20)} ${esc(
                        t('add_item')
                      )}</button></div>`
                    : ''
                }
              </section>`
              )
              .join('')}
          </div>
          <div class="modal-foot r-table-foot">
            <div class="r-sum">
              <span class="r-meta">${esc(t('subtotal'))} ${money(tb.totals.subtotal)} · ${esc(t('service', { p: pct() }))} ${money(tb.totals.service)}</span><br />
              <b>${esc(t('total'))}: ${money(tb.totals.total)}</b>
            </div>
            <button type="button" class="btn btn-outline" data-new-order="${esc(openTable)}">${icon('plus', 22)} ${esc(t('new_order_for_table'))}</button>
            ${
              tb.billId
                ? `<button type="button" class="btn btn-primary" data-close-table="${esc(openTable)}" data-unready="${unready ? 1 : 0}">${icon('receipt', 22)} ${esc(
                    t('close_table')
                  )}</button>`
                : ''
            }
          </div>
        </div>
      </div>`;
    const body = $layerTable.querySelector('.modal-body');
    if (body) body.scrollTop = scroll;
  }

  // ---------- item picker (add to order / new order) ----------

  function openPicker(mode, { orderId, table }) {
    picker = { mode, orderId, table, draft: [], note: '', search: '', cat: null };
    renderPicker();
  }

  function renderPicker() {
    if (!picker) {
      $layerPicker.innerHTML = '';
      return;
    }
    const title = `${t('table')} ${picker.table} — ${t(picker.mode === 'new' ? 'new_order_for_table' : 'add_item')}`;
    $layerPicker.innerHTML = `
      <div class="modal-backdrop" data-close-layer="picker">
        <div class="modal wide r-picker" role="dialog" aria-modal="true">
          <button type="button" class="icon-btn modal-close" data-close-layer="picker" aria-label="${esc(t('close'))}">${icon('x', 26)}</button>
          <div class="modal-body">
            <div>
              <h2>${esc(title)}</h2>
              <input class="input" type="search" data-picker-search placeholder="${esc(t('search'))}" value="${esc(picker.search)}" />
              <div class="chips" id="picker-cats"></div>
              <div class="r-pick-list" id="picker-items"></div>
            </div>
            <div class="r-draft" id="picker-draft"></div>
          </div>
          <div class="modal-foot r-table-foot" id="picker-foot"></div>
        </div>
      </div>`;
    renderPickerCats();
    renderPickerItems();
    renderPickerDraft();
  }

  function renderPickerCats() {
    const el = document.getElementById('picker-cats');
    if (!el) return;
    el.innerHTML = [`<button type="button" class="chip" data-picker-cat="" aria-pressed="${!picker.cat}">${esc(t('all'))}</button>`]
      .concat(menu.categories.map((c) => `<button type="button" class="chip" data-picker-cat="${esc(c.id)}" aria-pressed="${picker.cat === c.id}">${esc(tr(c.name))}</button>`))
      .join('');
  }

  function renderPickerItems() {
    const el = document.getElementById('picker-items');
    if (!el) return;
    const q = picker.search.trim().toLowerCase();
    const out = soldOut();
    const items = menu.items.filter(
      (i) => (!picker.cat || i.category === picker.cat) && (!q || ['az', 'en', 'ru'].some((l) => (i.name[l] || '').toLowerCase().includes(q)))
    );
    el.innerHTML = items
      .map((i) => {
        const isOut = out.has(i.id);
        const buttons = i.variants
          ? i.variants
              .map((v) => `<button type="button" class="btn btn-outline btn-sm" data-pick="${esc(i.id)}" data-variant="${esc(v.id)}" ${isOut ? 'disabled' : ''}>${icon('plus', 16)} ${esc(tr(v.label))} · ${money(v.price)}</button>`)
              .join('')
          : `<button type="button" class="btn btn-outline btn-sm" data-pick="${esc(i.id)}" ${isOut ? 'disabled' : ''}>${icon('plus', 16)} ${money(i.price)}</button>`;
        return `
          <div class="r-pick">
            <img src="${esc(i.image)}" alt="" loading="lazy" />
            <div>
              <div class="r-pick-name">${esc(tr(i.name))} ${isOut ? `<span class="pill pill-red">${esc(t('sold_out'))}</span>` : ''}</div>
              <div class="r-pick-buttons">${buttons}</div>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderPickerDraft() {
    const el = document.getElementById('picker-draft');
    const foot = document.getElementById('picker-foot');
    if (!el || !foot) return;
    const draft = picker.draft;
    el.innerHTML = `
      <h3>${esc(t('nav_order'))}</h3>
      ${
        draft.length
          ? draft
              .map((d, i) => {
                const item = itemsById.get(d.itemId);
                const v = item.variants && item.variants.find((x) => x.id === d.variantId);
                return `
            <div class="r-draft-line">
              <div class="top">
                <span class="r-name">${esc(tr(item.name))}${v ? ` <small>${esc(tr(v.label))}</small>` : ''}</span>
                <div class="stepper small">
                  <button type="button" data-draft-qty="${i}" data-delta="-1" aria-label="-1">${icon('minus', 18)}</button>
                  <output>${d.qty}</output>
                  <button type="button" data-draft-qty="${i}" data-delta="1" aria-label="+1">${icon('plus', 18)}</button>
                </div>
              </div>
              <input class="input" data-draft-note="${i}" maxlength="200" placeholder="${esc(t('note_label'))}" value="${esc(d.note)}" />
            </div>`;
              })
              .join('')
          : `<p class="r-meta">${esc(t('draft_empty'))}</p>`
      }
      ${
        picker.mode === 'new'
          ? `<input class="input" data-picker-note maxlength="300" placeholder="${esc(t('order_note_label'))}" value="${esc(picker.note)}" />`
          : ''
      }`;
    const subtotal = draft.reduce((s, d) => {
      const item = itemsById.get(d.itemId);
      const v = item.variants && item.variants.find((x) => x.id === d.variantId);
      return s + (v ? v.price : item.price) * d.qty;
    }, 0);
    foot.innerHTML = `
      <div class="r-sum"><b>${money(subtotal)}</b></div>
      <button type="button" class="btn btn-outline" data-close-layer="picker">${esc(t('cancel'))}</button>
      <button type="button" class="btn btn-go" data-picker-submit ${draft.length ? '' : 'disabled'}>${icon('check', 22)} ${esc(
        t(picker.mode === 'new' ? 'send_to_kitchen' : 'add_selected')
      )}</button>`;
  }

  async function submitPicker() {
    const lines = picker.draft.map(({ itemId, variantId, qty, note }) => ({ itemId, variantId, qty, note, quickNotes: [] }));
    if (!lines.length) return;
    const p = picker;
    await act('picker', async () => {
      if (p.mode === 'new') await api('POST', `/api/tables/${p.table}/orders`, { lines, note: p.note });
      else await api('POST', `/api/orders/${p.orderId}/lines`, { lines });
      picker = null;
      renderPicker();
    });
  }

  // ---------- confirm dialog ----------

  function ask({ title, text, ok, okClass = 'btn-primary', onOk }) {
    confirmBox = { title, text, ok, okClass, onOk };
    $layerConfirm.innerHTML = `
      <div class="modal-backdrop" data-close-layer="confirm">
        <div class="modal" role="alertdialog" aria-modal="true" style="max-width:480px">
          <div class="modal-body dialog">
            <h2>${esc(title)}</h2>
            ${text ? `<p>${text}</p>` : ''}
          </div>
          <div class="modal-foot dialog-actions">
            <button type="button" class="btn ${okClass} btn-lg btn-block" data-confirm-ok>${esc(ok)}</button>
            <button type="button" class="btn btn-outline btn-block" data-close-layer="confirm">${esc(t('cancel'))}</button>
          </div>
        </div>
      </div>`;
  }

  function closeConfirm() {
    confirmBox = null;
    $layerConfirm.innerHTML = '';
  }

  // ---------- state & sounds ----------

  function onState(next) {
    clockOffset = next.serverTime - Date.now();
    view = next;
    renderHead();
    if (tab !== 'qr') renderMain();
    renderTableLayer();
  }

  function onDing(msg) {
    const labels = {
      order: t('new_order_alert', { t: msg.table }),
      waiter: t('call_alert', { t: msg.table, what: t('call_waiter_msg') }),
      bill: t('call_alert', { t: msg.table, what: t('call_bill_msg') }),
      ready: t('ready_alert', { t: msg.table }),
    };
    if (!labels[msg.type]) return;
    toast(`${icon(msg.type === 'ready' ? 'check' : 'bell', 24)} ${esc(labels[msg.type])}`, { ms: 5000 });
    if (!soundOn) return;
    const tunes = { order: [784, 988, 1175], waiter: [1046, 784, 1046], bill: [1046, 784, 1046], ready: [880, 1320] };
    B.chime(tunes[msg.type], { volume: 0.45 });
  }

  // ---------- events ----------

  document.addEventListener('click', (e) => {
    const el = (sel) => e.target.closest(sel);
    let m;

    if ((m = el('[data-close-layer]'))) {
      // Clicks inside a modal bubble to its backdrop; only close on the backdrop itself or a close button
      if (m.classList.contains('modal-backdrop') && e.target !== m) return handleInside(e);
      const layer = m.dataset.closeLayer;
      if (layer === 'table') {
        openTable = null;
        renderTableLayer();
      } else if (layer === 'picker') {
        picker = null;
        renderPicker();
      } else if (layer === 'confirm') closeConfirm();
      return;
    }
    handleInside(e);
  });

  function handleInside(e) {
    const el = (sel) => e.target.closest(sel);
    let m;
    if ((m = el('[data-tab]'))) {
      tab = m.dataset.tab;
      storageSet('borani-reception-tab', tab);
      renderHead();
      $main.innerHTML = '';
      renderMain();
      if (tab === 'qr') loadQr();
    } else if ((m = el('[data-open-table]'))) {
      openTable = m.dataset.openTable;
      renderTableLayer();
    } else if ((m = el('[data-approve]'))) {
      const id = m.dataset.approve;
      m.disabled = true;
      act(`approve:${id}`, () => api('POST', `/api/orders/${id}/approve`)).finally(() => (m.disabled = false));
    } else if ((m = el('[data-reject]'))) {
      const id = m.dataset.reject;
      ask({ title: t('reject_title'), text: esc(t('reject_text')), ok: t('reject'), okClass: 'btn-danger', onOk: () => api('POST', `/api/orders/${id}/reject`) });
    } else if ((m = el('[data-resolve]'))) {
      const id = m.dataset.resolve;
      act(`call:${id}`, () => api('POST', `/api/calls/${id}/resolve`));
    } else if ((m = el('[data-served]'))) {
      const id = m.dataset.served;
      act(`served:${id}`, () => api('POST', `/api/orders/${id}/served`));
    } else if ((m = el('[data-bar-line]'))) {
      const ready = m.dataset.ready === '1';
      m.classList.toggle('done', ready);
      m.dataset.ready = ready ? '0' : '1';
      act(`bar:${m.dataset.barLine}`, () => api('POST', `/api/orders/${m.dataset.order}/lines/${m.dataset.barLine}/ready`, { ready }));
    } else if ((m = el('[data-bar-all]'))) {
      const id = m.dataset.barAll;
      act(`barall:${id}`, () => api('POST', `/api/orders/${id}/ready`, { station: 'bar' }));
    } else if ((m = el('[data-line-qty]'))) {
      const { order, lineQty } = m.dataset;
      const qty = Number(m.dataset.qty);
      if (qty < 1) return askCancelLine(order, lineQty);
      act(`qty:${lineQty}`, () => api('POST', `/api/orders/${order}/lines/${lineQty}/qty`, { qty }));
    } else if ((m = el('[data-cancel-line]'))) {
      askCancelLine(m.dataset.order, m.dataset.cancelLine);
    } else if ((m = el('[data-add-to-order]'))) {
      const order = view.orders.find((o) => o.id === m.dataset.addToOrder);
      if (order) openPicker('add', { orderId: order.id, table: order.table });
    } else if ((m = el('[data-new-order]'))) {
      openPicker('new', { table: m.dataset.newOrder });
    } else if ((m = el('[data-close-table]'))) {
      const table = m.dataset.closeTable;
      const tb = view.tables.find((x) => x.table === table);
      const warn = m.dataset.unready === '1' ? `<br /><b style="color:var(--red)">${esc(t('close_unready'))}</b>` : '';
      ask({
        title: t('close_title', { t: table }),
        text: `${esc(t('close_text', { total: money(tb ? tb.totals.total : 0) }))}${warn}`,
        ok: t('close_table'),
        onOk: async () => {
          await api('POST', `/api/tables/${table}/close`);
          openTable = null;
          renderTableLayer();
        },
      });
    } else if ((m = el('[data-confirm-ok]'))) {
      const box = confirmBox;
      closeConfirm();
      if (box) act('confirm', box.onOk);
    } else if ((m = el('[data-pick]'))) {
      const itemId = m.dataset.pick;
      const variantId = m.dataset.variant || null;
      const same = picker.draft.find((d) => d.itemId === itemId && d.variantId === variantId && !d.note);
      if (same) same.qty = Math.min(20, same.qty + 1);
      else picker.draft.push({ itemId, variantId, qty: 1, note: '' });
      renderPickerDraft();
    } else if ((m = el('[data-draft-qty]'))) {
      const i = Number(m.dataset.draftQty);
      const d = picker.draft[i];
      d.qty += Number(m.dataset.delta);
      if (d.qty < 1) picker.draft.splice(i, 1);
      else d.qty = Math.min(20, d.qty);
      renderPickerDraft();
    } else if ((m = el('[data-picker-cat]'))) {
      picker.cat = m.dataset.pickerCat || null;
      renderPickerCats();
      renderPickerItems();
    } else if (el('[data-picker-submit]')) {
      submitPicker();
    } else if ((m = el('[data-sold-out]'))) {
      const id = m.dataset.soldOut;
      act(`sold:${id}`, () => api('POST', `/api/items/${id}/sold-out`, { soldOut: m.dataset.value === '1' }));
    } else if (el('[data-sound]')) {
      soundOn = !soundOn;
      storageSet('borani-reception-sound', soundOn);
      if (soundOn) B.chime([880]);
      renderHead();
    } else if (el('[data-fullscreen]')) {
      Staff.toggleFullscreen();
    } else if (el('[data-logout]')) {
      Staff.logout();
    }
  }

  function askCancelLine(orderId, lineId) {
    const order = view.orders.find((o) => o.id === orderId);
    const line = order && order.lines.find((l) => l.id === lineId);
    if (!line) return;
    ask({
      title: `${t('remove')}: ${line.qty}× ${tr(line.name)}?`,
      text: '',
      ok: t('remove'),
      okClass: 'btn-danger',
      onOk: () => api('POST', `/api/orders/${orderId}/lines/${lineId}/cancel`),
    });
  }

  document.addEventListener('input', (e) => {
    const m = e.target;
    if (m.matches('[data-menu-search]')) {
      menuSearch = m.value;
      renderMenuTab();
    } else if (m.matches('[data-picker-search]')) {
      picker.search = m.value;
      renderPickerItems();
    } else if (m.matches('[data-draft-note]')) {
      picker.draft[Number(m.dataset.draftNote)].note = m.value;
    } else if (m.matches('[data-picker-note]')) {
      picker.note = m.value;
    }
  });

  document.addEventListener('submit', (e) => {
    if (!e.target.matches('[data-table-count]')) return;
    e.preventDefault();
    const count = Number(new FormData(e.target).get('count'));
    act('tables', async () => {
      await api('POST', '/api/settings/tables', { count });
      await loadQr();
      toast(`${icon('check', 24)} ${esc(t('save'))}`);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (confirmBox) closeConfirm();
    else if (picker) {
      picker = null;
      renderPicker();
    } else if (openTable) {
      openTable = null;
      renderTableLayer();
    }
  });

  window.addEventListener('langchange', () => {
    renderHead();
    $main.innerHTML = '';
    renderMain();
    renderTableLayer();
    if (picker) renderPicker();
  });

  setInterval(() => {
    if (!document.body.classList.contains('started')) return;
    renderHead();
    if (tab === 'live' || tab === 'tables') renderMain();
    renderTableLayer();
  }, 30_000);

  // ---------- start ----------

  api('GET', '/api/menu').then((m) => {
    menu = m;
    itemsById = new Map(menu.items.map((i) => [i.id, i]));
    renderMain();
  });

  Staff.boot('reception', {
    onState,
    onDing,
    onStart: () => {
      if (tab === 'qr') loadQr();
    },
  });
})();
