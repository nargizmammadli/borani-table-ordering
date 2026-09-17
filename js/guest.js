// Guest phone app: menu -> item -> order -> send, plus live order status and waiter calls.
(function () {
  const { t, tr, esc, money, icon, api, toast, ago, storageGet, storageSet } = B;

  const [, , TABLE, CODE] = location.pathname.slice("/borani-table-ordering".length).split('/');
  const CART_KEY = `borani-cart-${TABLE}-${CODE}`;

  const $view = document.getElementById('view');
  const $hero = document.getElementById('hero');
  const $nav = document.getElementById('nav');
  const $cartbarSlot = document.getElementById('cartbar-slot');
  const $modalRoot = document.getElementById('modal-root');
  const $offline = document.getElementById('offline');

  let menu = null;
  let itemsById = new Map();
  let catsById = new Map();
  let guest = { orders: [], totals: { subtotal: 0, service: 0, total: 0 }, calls: [], soldOut: [] };
  let soldOut = new Set();
  let cart = storageGet(CART_KEY, { lines: [], note: '' });
  let section = sessionStorage.getItem('borani-section') || 'food';
  let canGoBack = false;
  let sending = false;
  const lineStatuses = new Map();
  const scrollMemory = {};

  // ---------- helpers ----------

  const saveCart = () => storageSet(CART_KEY, cart);
  const cartCount = () => cart.lines.reduce((n, l) => n + l.qty, 0);
  const servicePercent = () => menu.restaurant.serviceChargePercent;

  function unitPrice(item, variantId) {
    if (item.variants) {
      const v = item.variants.find((x) => x.id === variantId);
      return v ? v.price : item.price;
    }
    return item.price;
  }

  function priceLabel(item) {
    if (!item.variants) return money(item.price);
    const prices = item.variants.map((v) => v.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return min === max ? money(min) : `${(min / 100).toFixed(2)} – ${money(max)}`;
  }

  function cartTotals() {
    const subtotal = cart.lines.reduce((sum, l) => {
      const item = itemsById.get(l.itemId);
      return item ? sum + unitPrice(item, l.variantId) * l.qty : sum;
    }, 0);
    const service = Math.round((subtotal * servicePercent()) / 100);
    return { subtotal, service, total: subtotal + service };
  }

  const variantLabel = (item, variantId) => {
    const v = item.variants && item.variants.find((x) => x.id === variantId);
    return v ? tr(v.label) : '';
  };

  const lineKey = (l) => [l.itemId, l.variantId || '', [...l.quickNotes].sort().join(','), l.note.trim()].join('|');

  const qtyInCart = (itemId) => cart.lines.filter((l) => l.itemId === itemId).reduce((n, l) => n + l.qty, 0);

  const noteTags = (keys) =>
    keys && keys.length ? `<div class="note-tags">${keys.map((k) => `<span class="note-tag">${esc(t(`qn_${k}`))}</span>`).join('')}</div>` : '';

  const route = () => {
    const h = location.hash.replace(/^#\/?/, '');
    if (h.startsWith('c/')) return { name: 'category', id: h.slice(2) };
    if (h === 'order') return { name: 'order' };
    return { name: 'home' };
  };

  function go(hash) {
    if (modal) dropModal({ replaceWith: hash });
    else location.hash = hash;
  }

  // ---------- modal (bottom sheet) with phone back-button support ----------

  let modal = null;

  function openModal(renderFn, { onMount } = {}) {
    if (!modal) history.pushState({ modal: true }, '');
    modal = { renderFn, onMount };
    paintModal();
  }

  function paintModal() {
    if (!modal) return;
    const alreadyOpen = $modalRoot.childElementCount > 0;
    $modalRoot.innerHTML = `<div class="modal-backdrop${alreadyOpen ? ' static' : ''}" data-backdrop><div class="modal" role="dialog" aria-modal="true">${modal.renderFn()}</div></div>`;
    if (modal.onMount) modal.onMount($modalRoot.querySelector('.modal'));
  }

  function closeModal() {
    if (!modal) return;
    modal = null;
    $modalRoot.innerHTML = '';
    history.back();
  }

  // Remove the sheet without going back in history (used when the sheet itself navigates somewhere)
  function dropModal({ replaceWith } = {}) {
    modal = null;
    $modalRoot.innerHTML = '';
    if (replaceWith !== undefined) {
      history.replaceState(null, '', replaceWith);
      render();
    }
  }

  window.addEventListener('popstate', () => {
    if (modal) {
      modal = null;
      $modalRoot.innerHTML = '';
    }
  });

  $modalRoot.addEventListener('click', (e) => {
    if (e.target.matches('[data-backdrop]') || e.target.closest('[data-close]')) closeModal();
  });

  // ---------- header, nav, cart bar ----------

  function renderHero(compact) {
    const r = menu.restaurant;
    $hero.className = `hero${compact ? ' compact' : ''}`;
    $hero.innerHTML = `
      <div class="hero-top">
        <div class="brand">
          <img src="/borani-table-ordering/img/logo.jpg" alt="" width="56" height="56" />
          <div>
            <div class="brand-name">${esc(r.name)}</div>
            ${compact ? '' : `<div class="brand-sub">${esc(r.address)}</div>`}
          </div>
        </div>
        ${B.langSwitch()}
      </div>
      <div class="table-badge">${esc(t('table'))} ${esc(TABLE)}</div>`;
  }

  function renderNav() {
    const r = route().name;
    const count = cartCount();
    const tab = (name, hash, ic, label, badge = '') =>
      `<button type="button" data-go="${hash}" ${r === name || (name === 'home' && r === 'category') ? 'aria-current="page"' : ''}>
        ${icon(ic, 28)}<span>${esc(label)}</span>${badge}
      </button>`;
    $nav.innerHTML =
      tab('home', '#/', 'menu', t('nav_menu')) +
      tab('order', '#/order', 'order', t('nav_order'), count ? `<span class="nav-badge">${count}</span>` : '') +
      `<button type="button" data-waiter>${icon('bell', 28)}<span>${esc(t('nav_waiter'))}</span>${
        guest.calls.length ? '<span class="nav-badge">!</span>' : ''
      }</button>`;
  }

  function renderCartBar(bump = false) {
    const show = cart.lines.length > 0 && route().name !== 'order';
    document.body.classList.toggle('has-cartbar', show);
    if (!show) {
      $cartbarSlot.innerHTML = '';
      return;
    }
    const n = cartCount();
    $cartbarSlot.innerHTML = `
      <div class="cartbar${bump ? ' bump' : ''}">
        <button type="button" data-go="#/order">
          <span>
            <span class="count">${esc(t('items', { n }))}</span><br />
            <span class="sum">${money(cartTotals().subtotal)}</span>
          </span>
          <span class="cta">${esc(t('view_order'))} ${icon('chevron', 22)}</span>
        </button>
      </div>`;
  }

  // ---------- views ----------

  function render() {
    const r = route();
    renderHero(r.name !== 'home');
    renderNav();
    renderCartBar();
    if (r.name === 'category' && catsById.has(r.id)) renderCategory(catsById.get(r.id));
    else if (r.name === 'order') renderOrder();
    else renderHome();
  }

  function renderHome() {
    const cats = menu.categories.filter((c) => c.section === section);
    const firstVisit = cart.lines.length === 0 && guest.orders.length === 0;
    $view.innerHTML = `
      ${
        firstVisit
          ? `<section class="welcome">
              <h1>${esc(t('welcome'))}</h1>
              <ol class="steps">
                <li><b>1</b>${esc(t('step_choose'))}</li>
                <li><b>2</b>${esc(t('step_add'))}</li>
                <li><b>3</b>${esc(t('step_send'))}</li>
              </ol>
            </section>`
          : ''
      }
      <div class="section-switch" role="group">
        <button type="button" data-section="food" aria-pressed="${section === 'food'}">${icon('menu', 24)} ${esc(t('section_food'))}</button>
        <button type="button" data-section="bar" aria-pressed="${section === 'bar'}">${icon('cup', 24)} ${esc(t('section_bar'))}</button>
      </div>
      <div class="categories">
        ${cats
          .map(
            (c) => `
          <button type="button" class="category" data-category="${esc(c.id)}" style="background-image:url('${esc(c.image)}')">
            <span class="category-name">${esc(tr(c.name))}</span>
            <span class="go">${icon('chevron', 26)}</span>
          </button>`
          )
          .join('')}
      </div>`;
  }

  function renderCategory(cat) {
    const siblings = menu.categories.filter((c) => c.section === cat.section);
    const items = menu.items.filter((i) => i.category === cat.id);
    $view.innerHTML = `
      <div class="page-head">
        <div class="page-head-row">
          <button type="button" class="btn btn-outline btn-sm back-btn" data-back>${icon('back', 22)} ${esc(t('back'))}</button>
          <h1 class="page-title">${esc(tr(cat.name))}</h1>
        </div>
        <div class="cat-chips" id="cat-chips">
          ${siblings
            .map((c) => `<button type="button" data-switch-category="${esc(c.id)}" aria-current="${c.id === cat.id}">${esc(tr(c.name))}</button>`)
            .join('')}
        </div>
      </div>
      <div class="items">
        ${items.map(itemCard).join('')}
      </div>`;
    const current = document.querySelector('#cat-chips [aria-current="true"]');
    if (current) current.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function itemCard(item) {
    const out = soldOut.has(item.id);
    const inCart = qtyInCart(item.id);
    return `
      <article class="item${out ? ' sold-out' : ''}" ${out ? '' : `data-item="${esc(item.id)}"`}>
        <div class="item-photo">
          <img src="${esc(item.image)}" alt="" loading="lazy" width="550" height="350" />
          ${inCart ? `<span class="pill pill-green in-order">${icon('check', 18)} ${esc(t('in_order', { n: inCart }))}</span>` : ''}
        </div>
        <div class="item-body">
          <h2 class="item-name">${esc(tr(item.name))}</h2>
          ${item.description && tr(item.description) ? `<p class="item-desc">${esc(tr(item.description))}</p>` : ''}
          <div class="item-foot">
            <span class="price">${priceLabel(item)}</span>
            ${
              out
                ? `<span class="pill pill-grey">${esc(t('sold_out'))}</span>`
                : `<button type="button" class="btn btn-primary" data-item="${esc(item.id)}">${icon('plus', 22)} ${esc(t('add'))}</button>`
            }
          </div>
        </div>
      </article>`;
  }

  // ---------- item sheet ----------

  function openItem(itemId, editIndex = null) {
    const item = itemsById.get(itemId);
    if (!item) return;
    const existing = editIndex != null ? cart.lines[editIndex] : null;
    const s = {
      item,
      editIndex,
      variantId: existing ? existing.variantId : null,
      qty: existing ? existing.qty : 1,
      quickNotes: new Set(existing ? existing.quickNotes : []),
      note: existing ? existing.note : '',
      needsChoice: false,
    };
    const cat = catsById.get(item.category);
    const quickKeys = menu.quickNotes[cat.quickNotes] || [];
    const isSize = item.variants && /\d/.test(item.variants[0].label.en);

    const paint = () => {
      const price = unitPrice(item, s.variantId);
      return `
        <button type="button" class="icon-btn modal-close" data-close aria-label="${esc(t('close'))}">${icon('x', 26)}</button>
        <div class="modal-body">
          <div class="sheet-photo"><img src="${esc(item.image)}" alt="" width="550" height="350" /></div>
          <h2 class="sheet-title">${esc(tr(item.name))}</h2>
          ${tr(item.description) ? `<p class="sheet-desc">${esc(tr(item.description))}</p>` : ''}
          ${item.variants ? '' : `<div class="price">${money(item.price)}</div>`}

          ${
            item.variants
              ? `<section class="sheet-section${s.needsChoice ? ' needs-choice' : ''}" id="variant-section">
                  <span class="field-label">${esc(t(isSize ? 'choose_size' : 'choose_option'))}</span>
                  <div class="options" role="radiogroup">
                    ${item.variants
                      .map(
                        (v) => `
                      <button type="button" class="option" role="radio" aria-checked="${s.variantId === v.id}" data-variant="${esc(v.id)}">
                        <span class="radio"></span>
                        <span>${esc(tr(v.label))}</span>
                        <span class="option-price">${money(v.price)}</span>
                      </button>`
                      )
                      .join('')}
                  </div>
                  <div class="required-msg">${icon('alert', 20)} ${esc(t('choose_required'))}</div>
                </section>`
              : ''
          }

          <section class="sheet-section qty-row">
            <span class="field-label">${esc(t('how_many'))}</span>
            <div class="stepper">
              <button type="button" data-qty="-1" aria-label="-1">${icon('minus', 26)}</button>
              <output aria-live="polite">${s.qty}</output>
              <button type="button" data-qty="1" aria-label="+1">${icon('plus', 26)}</button>
            </div>
          </section>

          ${
            quickKeys.length
              ? `<section class="sheet-section">
                  <span class="field-label">${esc(t('requests'))}</span>
                  <p class="hint">${esc(t('requests_hint'))}</p>
                  <div class="chips">
                    ${quickKeys
                      .map(
                        (k) =>
                          `<button type="button" class="chip" data-quick="${k}" aria-pressed="${s.quickNotes.has(k)}">${icon('check', 20)}${esc(t(`qn_${k}`))}</button>`
                      )
                      .join('')}
                  </div>
                </section>`
              : ''
          }

          <section class="sheet-section">
            <label class="field-label" for="item-note">${esc(t('note_label'))}</label>
            <textarea id="item-note" class="textarea" rows="2" maxlength="200" placeholder="${esc(t('note_placeholder'))}">${esc(s.note)}</textarea>
          </section>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-primary btn-lg btn-block" data-confirm-item>
            ${icon(editIndex != null ? 'check' : 'plus', 24)}
            ${esc(t(editIndex != null ? 'save_changes' : 'add_to_order'))}
            ${s.variantId || !item.variants ? ` · ${money(price * s.qty)}` : ''}
          </button>
        </div>`;
    };

    const mount = (root) => {
      const body = root.querySelector('.modal-body');
      root.querySelector('#item-note').addEventListener('input', (e) => (s.note = e.target.value));
      root.addEventListener('click', (e) => {
        const v = e.target.closest('[data-variant]');
        const q = e.target.closest('[data-qty]');
        const chip = e.target.closest('[data-quick]');
        if (v) {
          s.variantId = v.dataset.variant;
          s.needsChoice = false;
          repaint(body);
        } else if (q) {
          s.qty = Math.min(20, Math.max(1, s.qty + Number(q.dataset.qty)));
          repaint(body);
        } else if (chip) {
          const k = chip.dataset.quick;
          if (s.quickNotes.has(k)) s.quickNotes.delete(k);
          else {
            s.quickNotes.add(k);
            // "spicy" and "not spicy" cannot both be chosen
            if (k === 'spicy') s.quickNotes.delete('not_spicy');
            if (k === 'not_spicy') s.quickNotes.delete('spicy');
          }
          repaint(body);
        } else if (e.target.closest('[data-confirm-item]')) {
          confirmItem(s, body);
        }
      });
    };

    const repaint = (oldBody) => {
      const scroll = oldBody ? oldBody.scrollTop : 0;
      paintModal();
      const body = $modalRoot.querySelector('.modal-body');
      if (body) body.scrollTop = scroll;
    };

    openModal(paint, { onMount: mount });
  }

  function confirmItem(s, body) {
    if (s.item.variants && !s.variantId) {
      s.needsChoice = true;
      const scroll = body.scrollTop;
      paintModal();
      const section = $modalRoot.querySelector('#variant-section');
      const newBody = $modalRoot.querySelector('.modal-body');
      newBody.scrollTop = scroll;
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const line = {
      itemId: s.item.id,
      variantId: s.variantId,
      qty: s.qty,
      quickNotes: [...s.quickNotes],
      note: s.note.trim().slice(0, 200),
    };
    if (s.editIndex != null) {
      cart.lines[s.editIndex] = line;
    } else {
      const same = cart.lines.find((l) => lineKey(l) === lineKey(line));
      if (same) same.qty = Math.min(20, same.qty + line.qty);
      else cart.lines.push(line);
    }
    saveCart();
    closeModal();
    if (s.editIndex == null) toast(`${icon('check', 24)} ${esc(t('added_toast'))}`);
    // The sheet closes via history.back(); repaint once the page underneath is active again
    setTimeout(() => {
      if (route().name === 'category') {
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
      } else render();
      renderCartBar(true);
    }, 30);
  }

  // ---------- order page ----------

  function renderOrder() {
    $view.innerHTML = `<div class="order-page">${cart.lines.length ? draftCard() : ''}<div id="sent"></div>${
      !cart.lines.length && !guest.orders.length ? emptyOrder() : ''
    }</div>`;
    renderSent();
    const note = document.getElementById('order-note');
    if (note) note.addEventListener('input', (e) => {
      cart.note = e.target.value.slice(0, 300);
      saveCart();
    });
    window.scrollTo(0, 0);
  }

  function emptyOrder() {
    return `
      <div class="card empty">
        ${icon('order', 56)}
        <h2>${esc(t('empty_title'))}</h2>
        <p>${esc(t('empty_text'))}</p>
        <button type="button" class="btn btn-primary btn-lg" data-go="#/">${icon('menu', 24)} ${esc(t('open_menu'))}</button>
      </div>`;
  }

  function draftCard() {
    const totals = cartTotals();
    const hasSoldOut = cart.lines.some((l) => soldOut.has(l.itemId));
    return `
      <section class="card">
        <div class="card-head draft"><h2>${icon('clock', 26)} ${esc(t('not_sent_title'))}</h2></div>
        <div class="card-pad"><p class="card-hint">${esc(t('not_sent_hint'))}</p></div>
        <div>
          ${cart.lines
            .map((l, i) => {
              const item = itemsById.get(l.itemId);
              if (!item) return '';
              const price = unitPrice(item, l.variantId);
              const out = soldOut.has(l.itemId);
              return `
              <div class="line">
                <img class="line-thumb" src="${esc(item.image)}" alt="" width="72" height="72" loading="lazy" />
                <div>
                  <p class="line-name">${esc(tr(item.name))}${l.variantId ? ` <span class="line-variant">· ${esc(variantLabel(item, l.variantId))}</span>` : ''}</p>
                  ${out ? `<span class="pill pill-red">${esc(t('sold_out'))}</span>` : ''}
                  <div class="line-price">${l.qty} × ${money(price)} = <b>${money(price * l.qty)}</b></div>
                  ${noteTags(l.quickNotes)}
                  ${l.note ? `<div class="line-note">“${esc(l.note)}”</div>` : ''}
                  <div class="line-actions">
                    <div class="stepper small">
                      <button type="button" data-cart-qty="${i}" data-delta="-1" aria-label="-1">${icon('minus', 22)}</button>
                      <output>${l.qty}</output>
                      <button type="button" data-cart-qty="${i}" data-delta="1" aria-label="+1">${icon('plus', 22)}</button>
                    </div>
                    <button type="button" class="link-btn" data-cart-edit="${i}">${icon('pencil', 20)} ${esc(t('change'))}</button>
                    <button type="button" class="link-btn danger" data-cart-remove="${i}">${icon('trash', 20)} ${esc(t('remove'))}</button>
                  </div>
                </div>
              </div>`;
            })
            .join('')}
        </div>
        <div class="card-pad">
          <label class="field-label" for="order-note">${esc(t('order_note_label'))}</label>
          <textarea id="order-note" class="textarea" rows="2" maxlength="300" placeholder="${esc(t('order_note_placeholder'))}">${esc(cart.note)}</textarea>
        </div>
        <div class="totals">
          <div><span>${esc(t('subtotal'))}</span><span>${money(totals.subtotal)}</span></div>
          <div><span>${esc(t('service', { p: servicePercent() }))}</span><span>${money(totals.service)}</span></div>
          <div class="grand"><span>${esc(t('total'))}</span><span>${money(totals.total)}</span></div>
        </div>
        <div class="card-pad" style="display:grid;gap:10px">
          <button type="button" class="btn btn-go btn-lg btn-block" data-send ${hasSoldOut || sending ? 'disabled' : ''}>${icon('check', 26)} ${esc(
            t('send_order')
          )} · ${money(totals.total)}</button>
          <button type="button" class="btn btn-outline btn-block" data-go="#/">${icon('plus', 22)} ${esc(t('add_more'))}</button>
        </div>
      </section>`;
  }

  function orderStatus(o) {
    if (o.status === 'pending') return ['amber', 'clock', t('status_pending')];
    if (o.status === 'rejected') return ['red', 'x', t('status_rejected')];
    const live = o.lines.filter((l) => l.status !== 'cancelled');
    if (live.length && live.every((l) => l.status === 'served')) return ['green', 'check', t('status_served')];
    if (live.length && live.every((l) => l.status === 'ready' || l.status === 'served')) return ['green', 'check', t('status_ready')];
    if (!live.length) return ['grey', 'x', t('status_cancelled')];
    return ['blue', 'flame', t('status_todo')];
  }

  function lineStatus(order, l) {
    if (l.status === 'cancelled') return ['grey', 'x', t('status_cancelled')];
    if (order.status === 'pending') return ['amber', 'clock', t('status_pending')];
    if (order.status === 'rejected') return ['red', 'x', t('status_rejected')];
    if (l.status === 'served') return ['green', 'check', t('status_served')];
    if (l.status === 'ready') return ['green', 'check', t('status_ready')];
    return ['blue', 'flame', t('status_todo')];
  }

  function renderSent() {
    const el = document.getElementById('sent');
    if (!el) return;
    if (!guest.orders.length) {
      el.innerHTML = '';
      return;
    }
    const pill = ([color, ic, text]) => `<span class="pill pill-${color}">${icon(ic, 18)} ${esc(text)}</span>`;
    el.innerHTML = `
      <h2 class="section-title">${esc(t('sent_orders'))}</h2>
      <div style="display:grid;gap:14px;margin-top:10px">
        ${guest.orders
          .map(
            (o) => `
          <section class="card">
            <div class="card-head">
              <h2>${esc(t('order_no', { no: o.no }))}</h2>
              ${pill(orderStatus(o))}
            </div>
            <div class="order-meta" style="padding:8px 18px 0">${B.clock(o.createdAt)}${o.byStaff ? ` · ${esc(t('added_by_staff'))}` : ''}</div>
            ${o.status === 'rejected' ? `<div class="rejected-box">${esc(t('rejected_text'))}</div>` : ''}
            ${o.note ? `<p class="order-note">${icon('note', 18)} ${esc(o.note)}</p>` : ''}
            <div>
              ${o.lines
                .map(
                  (l) => `
                <div class="sent-line${l.status === 'cancelled' ? ' cancelled' : ''}">
                  <div>
                    <p class="line-name"><span class="qty">${l.qty}×</span> ${esc(tr(l.name))}${l.variantLabel ? ` <span class="line-variant">· ${esc(tr(l.variantLabel))}</span>` : ''}</p>
                    ${noteTags(l.quickNotes)}
                    ${l.note ? `<div class="line-note">“${esc(l.note)}”</div>` : ''}
                    <div class="line-price">${money(l.price * l.qty)}</div>
                  </div>
                  ${pill(lineStatus(o, l))}
                </div>`
                )
                .join('')}
            </div>
          </section>`
          )
          .join('')}
        <section class="card">
          <div class="card-head"><h2>${icon('receipt', 26)} ${esc(t('table_bill'))}</h2></div>
          <div class="totals" style="border-top:0">
            <div><span>${esc(t('subtotal'))}</span><span>${money(guest.totals.subtotal)}</span></div>
            <div><span>${esc(t('service', { p: servicePercent() }))}</span><span>${money(guest.totals.service)}</span></div>
            <div class="grand"><span>${esc(t('total'))}</span><span>${money(guest.totals.total)}</span></div>
          </div>
          <div class="card-pad" style="border-top:1px solid var(--line)">
            <p class="card-hint" style="margin-bottom:12px">${esc(t('change_hint'))}</p>
            <button type="button" class="btn btn-outline btn-block" data-waiter>${icon('bell', 22)} ${esc(t('call_waiter'))}</button>
          </div>
        </section>
      </div>`;
  }

  function confirmSend() {
    if (!cart.lines.length || sending) return;
    const totals = cartTotals();
    openModal(
      () => `
      <div class="modal-body dialog">
        <h2>${esc(t('confirm_send_title'))}</h2>
        <p>${esc(t('confirm_send_text'))}</p>
        <p style="font-size:22px;font-weight:900;color:var(--ink)">${esc(t('items', { n: cartCount() }))} · ${money(totals.total)}</p>
      </div>
      <div class="modal-foot dialog-actions">
        <button type="button" class="btn btn-go btn-lg btn-block" data-do-send>${icon('check', 26)} ${esc(t('yes_send'))}</button>
        <button type="button" class="btn btn-outline btn-block" data-close>${esc(t('not_yet'))}</button>
      </div>`,
      {
        onMount: (root) =>
          root.querySelector('[data-do-send]').addEventListener('click', (e) => {
            e.currentTarget.disabled = true;
            sendOrder();
          }),
      }
    );
  }

  async function sendOrder() {
    if (sending) return;
    sending = true;
    try {
      await api('POST', `/api/table/${TABLE}/${CODE}/orders`, {
        note: cart.note,
        lines: cart.lines.map(({ itemId, variantId, qty, quickNotes, note }) => ({ itemId, variantId, qty, quickNotes, note })),
      });
      cart = { lines: [], note: '' };
      saveCart();
      await refreshGuest();
      closeModal();
      toast(`${icon('check', 24)} ${esc(t('sent_toast'))}`, { ms: 3500 });
    } catch (err) {
      closeModal();
      const key = { too_many_pending: 'error_too_many_pending', item_sold_out: 'error_item_sold_out' }[err.code] || 'error_generic';
      toast(`${icon('alert', 24)} ${esc(t(key))}`, { kind: 'error', ms: 4500 });
      if (err.code === 'item_sold_out') await refreshGuest();
    } finally {
      sending = false;
      setTimeout(render, 30);
    }
  }

  // ---------- waiter / bill ----------

  function openWaiter() {
    let step = 'choose';
    const paint = () => {
      const calls = guest.calls;
      const waiterCall = calls.find((c) => c.type === 'waiter');
      const billCall = calls.find((c) => c.type === 'bill');
      const status = (text, call) =>
        `<div class="status-box">${icon('check', 26)}<div>${esc(text)}<small>${esc(ago(call.createdAt))}</small></div></div>`;
      if (step === 'pay') {
        return `
          <button type="button" class="icon-btn modal-close" data-close aria-label="${esc(t('close'))}">${icon('x', 26)}</button>
          <div class="modal-body dialog">
            <h2>${esc(t('pay_how'))}</h2>
            ${guest.totals.total ? `<p style="font-size:22px;font-weight:900;color:var(--ink)">${esc(t('total'))}: ${money(guest.totals.total)}</p>` : ''}
            <div class="pay-grid">
              <button type="button" class="help-btn" data-pay="cash"><span class="icon-wrap">${icon('cash', 30)}</span>${esc(t('cash'))}</button>
              <button type="button" class="help-btn" data-pay="card"><span class="icon-wrap">${icon('card', 30)}</span>${esc(t('card'))}</button>
            </div>
          </div>
          <div class="modal-foot"><button type="button" class="btn btn-outline btn-block" data-step="choose">${icon('back', 22)} ${esc(t('back'))}</button></div>`;
      }
      return `
        <button type="button" class="icon-btn modal-close" data-close aria-label="${esc(t('close'))}">${icon('x', 26)}</button>
        <div class="modal-body dialog">
          <h2>${esc(t('waiter_title'))}</h2>
          ${waiterCall ? status(t('waiter_called'), waiterCall) : ''}
          ${billCall ? status(t('bill_requested'), billCall) : ''}
          <div class="help-actions">
            <button type="button" class="help-btn" data-call="waiter"><span class="icon-wrap">${icon('bell', 30)}</span>${esc(t('call_waiter'))}</button>
            <button type="button" class="help-btn" data-step="pay"><span class="icon-wrap">${icon('receipt', 30)}</span>${esc(t('ask_bill'))}</button>
          </div>
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-outline btn-block" data-close>${esc(t('close'))}</button></div>`;
    };

    const mount = (root) => {
      root.addEventListener('click', async (e) => {
        const stepBtn = e.target.closest('[data-step]');
        const callBtn = e.target.closest('[data-call]');
        const payBtn = e.target.closest('[data-pay]');
        if (stepBtn) {
          step = stepBtn.dataset.step;
          paintModal();
        } else if (callBtn || payBtn) {
          const btn = callBtn || payBtn;
          btn.disabled = true;
          try {
            await api('POST', `/api/table/${TABLE}/${CODE}/calls`, callBtn ? { type: 'waiter' } : { type: 'bill', payMethod: payBtn.dataset.pay });
            await refreshGuest();
            step = 'choose';
            paintModal();
          } catch {
            btn.disabled = false;
            toast(`${icon('alert', 24)} ${esc(t('error_generic'))}`, { kind: 'error' });
          }
        }
      });
    };
    openModal(paint, { onMount: mount });
    waiterModalPaint = paint;
  }
  let waiterModalPaint = null;

  // ---------- live state ----------

  function applyState(next) {
    if (!next || !Array.isArray(next.orders)) return;
    for (const o of next.orders) {
      for (const l of o.lines) {
        const prev = lineStatuses.get(l.id);
        if (prev && prev === 'todo' && l.status === 'ready' && o.status === 'approved') {
          toast(`${icon('check', 24)} ${esc(t('item_ready', { name: tr(l.name) }))}`, { ms: 4500 });
          if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
        }
        lineStatuses.set(l.id, l.status);
      }
    }
    guest = next;
    soldOut = new Set(next.soldOut || []);
    renderNav();
    if (route().name === 'order') {
      const shouldBeEmpty = !cart.lines.length && !guest.orders.length;
      const isEmpty = Boolean(document.querySelector('.order-page > .empty'));
      if (!document.getElementById('sent') || shouldBeEmpty !== isEmpty) renderOrder();
      else renderSent();
    }
    if (modal && modal.renderFn === waiterModalPaint) paintModal();
  }

  async function refreshGuest() {
    try {
      applyState(await api('GET', `/api/table/${TABLE}/${CODE}`));
    } catch {
      /* socket will catch up */
    }
  }

  function connect() {
    const socket = io({ transports: ['websocket', 'polling'] });
    let offlineTimer = null;
    const join = () =>
      socket.emit('join', { type: 'table', table: TABLE, code: CODE }, (res) => {
        if (res && res.ok) applyState(res.state);
      });
    socket.on('connect', () => {
      clearTimeout(offlineTimer);
      $offline.hidden = true;
      join();
    });
    socket.on('disconnect', () => {
      offlineTimer = setTimeout(() => {
        $offline.textContent = t('offline');
        $offline.hidden = false;
      }, 2500);
    });
    socket.on('state', applyState);
    socket.on('soldOut', (list) => {
      soldOut = new Set(list);
      const r = route();
      if (r.name === 'category' && !modal) render();
    });
    socket.on('closed', () => {
      const hadOrders = guest.orders.length > 0 || lineStatuses.size > 0;
      refreshGuest().then(() => {
        if (!hadOrders) return;
        openModal(
          () => `
          <div class="modal-body dialog empty">
            ${icon('check', 56)}
            <h2 style="margin-right:0">${esc(t('closed_title'))}</h2>
            <p>${esc(t('closed_text'))}</p>
          </div>
          <div class="modal-foot"><button type="button" class="btn btn-primary btn-block" data-close>${esc(t('close'))}</button></div>`
        );
      });
    });
  }

  // ---------- events ----------

  document.addEventListener('click', (e) => {
    const el = (sel) => e.target.closest(sel);
    let m;
    if ((m = el('[data-go]'))) {
      go(m.dataset.go);
    } else if ((m = el('[data-section]'))) {
      section = m.dataset.section;
      sessionStorage.setItem('borani-section', section);
      scrollMemory.home = window.scrollY;
      renderHome();
    } else if ((m = el('[data-category]'))) {
      scrollMemory.home = window.scrollY;
      canGoBack = true;
      location.hash = `#/c/${m.dataset.category}`;
    } else if ((m = el('[data-switch-category]'))) {
      location.replace(`#/c/${m.dataset.switchCategory}`);
    } else if (el('[data-back]')) {
      if (canGoBack) history.back();
      else location.replace('#/');
    } else if ((m = el('[data-item]')) && !$modalRoot.contains(m)) {
      openItem(m.dataset.item);
    } else if ((m = el('[data-cart-qty]'))) {
      const line = cart.lines[Number(m.dataset.cartQty)];
      line.qty = Math.min(20, Math.max(1, line.qty + Number(m.dataset.delta)));
      saveCart();
      renderOrder();
      renderNav();
    } else if ((m = el('[data-cart-edit]'))) {
      const i = Number(m.dataset.cartEdit);
      openItem(cart.lines[i].itemId, i);
    } else if ((m = el('[data-cart-remove]'))) {
      cart.lines.splice(Number(m.dataset.cartRemove), 1);
      saveCart();
      renderOrder();
      renderNav();
    } else if (el('[data-send]')) {
      confirmSend();
    } else if (el('[data-waiter]') && !$modalRoot.contains(e.target)) {
      openWaiter();
    }
  });

  window.addEventListener('hashchange', () => {
    const r = route();
    if (r.name === 'category') window.scrollTo(0, 0);
    render();
    // Coming back to the category list: return to where the guest was
    if (r.name === 'home') {
      canGoBack = false;
      window.scrollTo(0, scrollMemory.home || 0);
    }
  });

  window.addEventListener('langchange', () => {
    render();
    if (modal) paintModal();
  });

  // Refresh "x min ago" labels in the waiter sheet
  setInterval(() => {
    if (modal && modal.renderFn === waiterModalPaint) paintModal();
  }, 30000);

  // ---------- start ----------

  function showInvalid() {
    $hero.innerHTML = '';
    $nav.remove();
    $view.innerHTML = `
      <div class="center-screen">
        <div class="empty">
          <img src="/borani-table-ordering/img/logo.jpg" alt="" width="82" height="82" style="border-radius:50%" />
          ${icon('alert', 48)}
          <h2>${esc(t('invalid_title'))}</h2>
          <p>${esc(t('invalid_text'))}</p>
          ${B.langSwitch()}
        </div>
      </div>`;
    window.addEventListener('langchange', showInvalid, { once: true });
  }

  async function start() {
    try {
      const [m, g] = await Promise.all([api('GET', '/api/menu'), api('GET', `/api/table/${TABLE}/${CODE}`)]);
      menu = m;
      itemsById = new Map(menu.items.map((i) => [i.id, i]));
      catsById = new Map(menu.categories.map((c) => [c.id, c]));
      // Drop anything from an older menu that no longer exists
      cart.lines = cart.lines.filter((l) => itemsById.has(l.itemId));
      applyState(g);
      render();
      connect();
    } catch (err) {
      if (err.status === 404) showInvalid();
      else {
        $view.innerHTML = `<div class="center-screen"><div class="empty">${icon('alert', 48)}<h2>${esc(t('error_generic'))}</h2>
          <button class="btn btn-primary" onclick="location.reload()">↻</button></div></div>`;
      }
    }
  }

  start();
})();
