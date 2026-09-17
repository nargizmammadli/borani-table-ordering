// Stand-in for server.js inside the browser, for the online demo on GitHub Pages (built by scripts/build-static.js).
// The pages still call fetch('/api/...') and io() exactly as they do with the real server; both are answered here.
// Every tab runs src/store.js on top of localStorage and tells the other tabs about each change,
// so guest, reception and kitchen tabs in the same browser update each other live.

/* global BUILD, createStore */

const BASE = BUILD.base;
const PINS = BUILD.pins;
const STATE_KEY = 'borani-demo-state';
const STAFF_KEY = 'borani-demo-staff';
const MENU_TEXT = JSON.stringify(BUILD.menu);
const realFetch = window.fetch.bind(window);

// ---------- storage (localStorage, or memory if the browser blocks it) ----------

const memory = new Map();
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory.has(key) ? memory.get(key) : null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      memory.delete(key);
    }
  },
};

// ---------- store: src/store.js with browser versions of fs, crypto and the secret key ----------

let store = null;
let storeRaw = null; // the saved state this tab's copy of the store was loaded from
const unsaved = new Map();

const shims = {
  fs: {
    readFileSync(file) {
      if (file.endsWith('/menu.json')) return MENU_TEXT;
      const raw = file.endsWith('/state.json') ? storage.get(STATE_KEY) : null;
      if (raw == null) throw new Error(`ENOENT: ${file}`);
      return raw;
    },
    writeFileSync(file, data) {
      unsaved.set(file, String(data));
    },
    renameSync(from, to) {
      if (!to.endsWith('/state.json') || !unsaved.has(from)) return;
      storeRaw = unsaved.get(from);
      unsaved.delete(from);
      storage.set(STATE_KEY, storeRaw);
    },
    mkdirSync() {},
  },
  path: { join: (...parts) => parts.join('/') },
  crypto: {
    randomBytes(size) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(size));
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return { toString: () => hex };
    },
  },
  // Table codes were signed at build time, so links and QR codes stay the same for everyone.
  './secret': { DATA_DIR: '/data', sign: (value) => BUILD.signatures[value] || '' },
};

// If another tab saved a change since this tab last looked, continue from the saved state.
function currentStore() {
  const raw = storage.get(STATE_KEY);
  if (!store || raw !== storeRaw) {
    storeRaw = raw;
    store = createStore(shims);
  }
  return store;
}

// ---------- staff login (remembered in this browser, like the server's cookie) ----------

const staffRole = () => {
  const role = storage.get(STAFF_KEY);
  return role && Object.prototype.hasOwnProperty.call(PINS, role) ? role : null;
};

// Reception is the manager screen, so it may also open the kitchen screen.
const canUse = (role, needed) => role === needed || (role === 'reception' && needed === 'kitchen');

// ---------- live updates: a socket.io stand-in shared between tabs ----------

const sockets = new Set();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('borani-demo') : null;

function fire(socket, event, data) {
  for (const fn of socket.handlers.get(event) || []) {
    try {
      fn(data);
    } catch (err) {
      console.error(err);
    }
  }
}

// Runs in every tab. "state" sends fresh snapshots to the rooms joined in this tab; events are passed on as they are.
function deliver(msg) {
  const s = currentStore();
  for (const socket of sockets) {
    if (msg.kind === 'event') {
      if (!msg.room || socket.rooms.has(msg.room)) fire(socket, msg.event, msg.data);
      continue;
    }
    if (socket.rooms.has('reception')) fire(socket, 'state', s.receptionView());
    if (socket.rooms.has('kitchen')) fire(socket, 'state', s.kitchenView());
    for (const table of msg.tables) if (socket.rooms.has(`table:${table}`)) fire(socket, 'state', s.guestView(table));
  }
}

function publish(msg) {
  setTimeout(() => deliver(msg), 0);
  if (channel) channel.postMessage(msg);
}

const broadcast = (tables = []) => publish({ kind: 'state', tables: [...new Set(tables)] });
const emitTo = (room, event, data) => publish({ kind: 'event', room, event, data });

const joinedTables = () =>
  [...sockets]
    .flatMap((socket) => [...socket.rooms])
    .filter((room) => room.startsWith('table:'))
    .map((room) => room.slice('table:'.length));

if (channel) channel.onmessage = (e) => deliver(e.data);
else window.addEventListener('storage', (e) => e.key === STATE_KEY && deliver({ kind: 'state', tables: joinedTables() }));

// Browsers may pause background tabs and drop their messages, so catch up when a tab is shown again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && storage.get(STATE_KEY) !== storeRaw) deliver({ kind: 'state', tables: joinedTables() });
});

function join(socket, msg, reply) {
  try {
    const s = currentStore();
    if (msg.type === 'table') {
      s.assertTable(String(msg.table), String(msg.code));
      socket.rooms.add(`table:${msg.table}`);
      return reply({ ok: true, state: s.guestView(String(msg.table)) });
    }
    const role = staffRole();
    if (msg.type === 'kitchen' && canUse(role, 'kitchen')) {
      socket.rooms.add('kitchen');
      return reply({ ok: true, state: s.kitchenView() });
    }
    if (msg.type === 'reception' && canUse(role, 'reception')) {
      socket.rooms.add('reception');
      return reply({ ok: true, state: s.receptionView() });
    }
    reply({ ok: false, error: 'login_required' });
  } catch (err) {
    reply({ ok: false, error: err.code || 'server_error' });
  }
}

window.io = function io() {
  const socket = {
    rooms: new Set(),
    handlers: new Map(),
    connected: true,
    on(event, fn) {
      if (!socket.handlers.has(event)) socket.handlers.set(event, []);
      socket.handlers.get(event).push(fn);
      return socket;
    },
    emit(event, msg, ack) {
      if (event === 'join') setTimeout(() => join(socket, msg || {}, typeof ack === 'function' ? ack : () => {}), 0);
      return socket;
    },
  };
  sockets.add(socket);
  setTimeout(() => fire(socket, 'connect'), 0);
  return socket;
};

// ---------- API: same routes and rules as server.js ----------

const routes = [];

function route(method, pattern, role, handler) {
  const keys = [];
  const source = pattern.replace(/:(\w+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp(`^${source}$`), keys, role, handler });
}

const httpError = (status, code) => Object.assign(new Error(code), { status, code });

const tablePath = (t) => `${BASE}/t/${t.table}/${t.code}/`;
const tableUrl = (t) => `${BUILD.pagesUrl}/t/${t.table}/${t.code}/`;

// QR codes are drawn at build time (img/qr/<table>.svg) and inlined here, as the server does.
const qrCache = new Map();
function qrSvg(table) {
  if (!qrCache.has(table)) {
    const svg = realFetch(`${BASE}/img/qr/${table}.svg`)
      .then((res) => (res.ok ? res.text() : ''))
      .catch(() => {
        qrCache.delete(table);
        return '';
      });
    qrCache.set(table, svg);
  }
  return qrCache.get(table);
}

const readyToServe = (o) => o.lines.some((l) => l.status === 'ready');
const hasTodoKitchen = (o) => o.lines.some((l) => l.station === 'kitchen' && l.status === 'todo');

function orderAction(fn, soundForKitchen) {
  return (req) => {
    const before = req.params.id ? req.store.findOrder(req.params.id) : null;
    const wasWaiting = before ? readyToServe(before) : false;
    const order = fn(req);
    broadcast([order.table]);
    if (soundForKitchen && soundForKitchen(order)) emitTo('kitchen', 'ding', { type: 'kitchen', table: order.table });
    if (!wasWaiting && readyToServe(order)) emitTo('reception', 'ding', { type: 'ready', table: order.table });
  };
}

// staff sessions

route('POST', '/api/login', null, ({ body }) => {
  const { role, pin } = body;
  if (!Object.prototype.hasOwnProperty.call(PINS, role) || String(pin) !== PINS[role]) throw httpError(401, 'wrong_pin');
  storage.set(STAFF_KEY, role);
  return { role };
});
route('POST', '/api/logout', null, () => storage.remove(STAFF_KEY));
route('GET', '/api/me', null, ({ role }) => ({ role }));

// guest

route('GET', '/api/menu', null, ({ store: s }) => ({ ...s.menu, quickNotes: s.QUICK_NOTES }));
route('GET', '/api/table/:table/:code', null, ({ store: s, params }) => {
  s.assertTable(params.table, params.code);
  return s.guestView(params.table);
});
route('POST', '/api/table/:table/:code/orders', null, ({ store: s, params, body }) => {
  const order = s.placeGuestOrder(params.table, params.code, body);
  broadcast([params.table]);
  emitTo('reception', 'ding', { type: 'order', table: params.table, no: order.no });
  return { orderId: order.id, no: order.no };
});
route('POST', '/api/table/:table/:code/calls', null, ({ store: s, params, body }) => {
  const call = s.callStaff(params.table, params.code, body);
  broadcast([params.table]);
  emitTo('reception', 'ding', { type: call.type, table: params.table });
  return { callId: call.id };
});

// reception

route('POST', '/api/orders/:id/approve', 'reception', orderAction((r) => r.store.approveOrder(r.params.id), hasTodoKitchen));
route('POST', '/api/orders/:id/reject', 'reception', orderAction((r) => r.store.rejectOrder(r.params.id, r.body.reason)));
route(
  'POST',
  '/api/orders/:id/lines/:lineId/qty',
  'reception',
  orderAction((r) => r.store.setLineQty(r.params.id, r.params.lineId, r.body.qty), (o) => o.kitchenAlert)
);
route(
  'POST',
  '/api/orders/:id/lines/:lineId/cancel',
  'reception',
  orderAction((r) => r.store.cancelLine(r.params.id, r.params.lineId), (o) => o.kitchenAlert)
);
route('POST', '/api/orders/:id/lines', 'reception', orderAction((r) => r.store.addLines(r.params.id, r.body.lines), (o) => o.kitchenAlert));
route('POST', '/api/tables/:table/orders', 'reception', orderAction((r) => r.store.placeStaffOrder(r.params.table, r.body), hasTodoKitchen));
route('POST', '/api/orders/:id/served', 'reception', orderAction((r) => r.store.markServed(r.params.id)));
route('POST', '/api/tables/:table/close', 'reception', ({ store: s, params }) => {
  s.closeTable(params.table);
  // "closed" goes first so guest phones still know they had orders when they show the thank-you message
  emitTo(`table:${params.table}`, 'closed');
  broadcast([params.table]);
});
route('POST', '/api/calls/:id/resolve', 'reception', ({ store: s, params }) => {
  const call = s.resolveCall(params.id);
  broadcast([call.table]);
});
route('POST', '/api/items/:id/sold-out', 'reception', ({ store: s, params, body }) => {
  s.setSoldOut(params.id, Boolean(body.soldOut));
  emitTo(null, 'soldOut', s.receptionView().soldOut);
  broadcast();
});
route('POST', '/api/settings/tables', 'reception', ({ store: s, body }) => {
  s.setTableCount(body.count);
  broadcast();
});
route('GET', '/api/qr-codes', 'reception', async ({ store: s }) => ({
  tables: await Promise.all(s.tableCodes().map(async (t) => ({ table: t.table, url: tableUrl(t), svg: await qrSvg(t.table) }))),
}));

// kitchen / preparation

route(
  'POST',
  '/api/orders/:id/lines/:lineId/ready',
  'kitchen',
  orderAction((r) => r.store.setLineReady(r.params.id, r.params.lineId, Boolean(r.body.ready), r.role))
);
route('POST', '/api/orders/:id/ready', 'kitchen', orderAction((r) => r.store.setStationReady(r.params.id, r.body.station, r.role)));
route('POST', '/api/orders/:id/seen', 'kitchen', orderAction((r) => r.store.ackKitchenChanges(r.params.id)));
route('POST', '/api/orders/:id/reopen', 'kitchen', orderAction((r) => r.store.reopenForKitchen(r.params.id)));

// demo launcher

route('GET', '/api/demo', null, async ({ store: s }) => ({
  tables: await Promise.all(
    s
      .tableCodes()
      .slice(0, 4)
      .map(async (t) => ({ table: t.table, url: tableUrl(t), path: tablePath(t), svg: await qrSvg(t.table) }))
  ),
  pins: PINS,
  base: BUILD.pagesUrl,
}));
route('POST', '/api/demo/reset', null, ({ store: s }) => {
  s.resetDemo();
  emitTo(null, 'closed');
  broadcast(s.tableCodes().map((t) => t.table));
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function answer(method, pathname, body) {
  try {
    for (const r of routes) {
      const match = r.method === method && r.regex.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(r.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      const role = staffRole();
      if (r.role && !canUse(role, r.role)) return json(401, { error: 'login_required' });
      const result = await r.handler({ params, body: body || {}, role, store: currentStore() });
      // As over a real network, live updates caused by this request reach the page before its response.
      await pause(15);
      return json(200, result ?? { ok: true });
    }
    return json(404, { error: 'not_found' });
  } catch (err) {
    if (err && err.status && err.code) return json(err.status, { error: err.code });
    console.error(err);
    return json(500, { error: 'server_error' });
  }
}

window.fetch = function fetch(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const pathname = url.pathname.startsWith(`${BASE}/api/`) ? url.pathname.slice(BASE.length) : url.pathname;
  if (url.origin !== location.origin || !pathname.startsWith('/api/')) return realFetch(input, init);
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let body = null;
  try {
    body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  return answer(method, pathname, body);
};
