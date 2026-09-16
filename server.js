const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const store = require('./src/store');

const PORT = Number(process.env.PORT) || 3000;
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
const PINS = {
  kitchen: process.env.KITCHEN_PIN || '1111',
  reception: process.env.RECEPTION_PIN || '2222',
};
const SESSION_DAYS = 30;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));

// ---------- staff sessions (PIN -> signed cookie) ----------

const { sign } = require('./src/secret');

function makeSession(role) {
  const payload = `${role}.${Date.now() + SESSION_DAYS * 864e5}`;
  return `${payload}.${sign(payload)}`;
}

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionRole(cookieHeader) {
  const raw = readCookie(cookieHeader, 'staff');
  if (!raw) return null;
  const [role, expires, sig] = raw.split('.');
  const expected = sign(`${role}.${expires}`);
  if (!sig || sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(expires) < Date.now() || !PINS[role]) return null;
  return role;
}

// Reception is the manager screen, so it may also open the kitchen screen.
const canUse = (role, needed) => role === needed || (role === 'reception' && needed === 'kitchen');

const requireRole = (needed) => (req, res, next) => {
  const role = sessionRole(req.headers.cookie);
  if (!role || !canUse(role, needed)) return res.status(401).json({ error: 'login_required' });
  req.role = role;
  next();
};

const loginAttempts = new Map();
app.post('/api/login', (req, res) => {
  const key = req.ip;
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 8) return res.status(429).json({ error: 'too_many_attempts' });

  const { role, pin } = req.body || {};
  if (!PINS[role] || String(pin) !== PINS[role]) {
    recent.push(now);
    loginAttempts.set(key, recent);
    return res.status(401).json({ error: 'wrong_pin' });
  }
  loginAttempts.delete(key);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `staff=${encodeURIComponent(makeSession(role))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'staff=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ role: sessionRole(req.headers.cookie) }));

// ---------- helpers ----------

// Prefer the real Wi-Fi/Ethernet adapter over virtual ones (WSL, Hyper-V, VirtualBox, Docker, VPNs).
function lanAddress() {
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|veth|br-|utun|tailscale|zerotier|vpn/i;
  const preferred = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d/i;
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
  }
  const best = candidates.find((c) => preferred.test(c.name)) || candidates[0];
  return best ? best.address : 'localhost';
}

// The address printed in QR codes must work from a guest's phone, so "localhost" is swapped for the LAN IP.
function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.get('host') || `localhost:${PORT}`;
  const [hostname, port] = host.split(':');
  if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return `http://${lanAddress()}${port ? `:${port}` : ''}`;
  return `${req.protocol}://${host}`;
}

const tableUrl = (req, { table, code }) => `${publicBase(req)}/t/${table}/${code}`;

// Every change is followed by fresh snapshots to everyone who needs them.
function broadcast(tables = []) {
  io.to('reception').emit('state', store.receptionView());
  io.to('kitchen').emit('state', store.kitchenView());
  for (const t of new Set(tables)) io.to(`table:${t}`).emit('state', store.guestView(t));
}

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof store.StoreError) return res.status(err.status).json({ error: err.code });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
};

// ---------- guest API ----------

app.get('/api/menu', (req, res) => {
  res.json({ ...store.menu, quickNotes: store.QUICK_NOTES });
});

app.get(
  '/api/table/:table/:code',
  handle((req) => {
    store.assertTable(req.params.table, req.params.code);
    return store.guestView(req.params.table);
  })
);

app.post(
  '/api/table/:table/:code/orders',
  handle((req) => {
    const { table, code } = req.params;
    const order = store.placeGuestOrder(table, code, req.body || {});
    broadcast([table]);
    io.to('reception').emit('ding', { type: 'order', table, no: order.no });
    return { orderId: order.id, no: order.no };
  })
);

app.post(
  '/api/table/:table/:code/calls',
  handle((req) => {
    const { table, code } = req.params;
    const call = store.callStaff(table, code, req.body || {});
    broadcast([table]);
    io.to('reception').emit('ding', { type: call.type, table });
    return { callId: call.id };
  })
);

// ---------- reception API ----------

const reception = requireRole('reception');
const kitchen = requireRole('kitchen');

const readyToServe = (o) => o.lines.some((l) => l.status === 'ready');

function orderAction(fn, soundForKitchen) {
  return handle((req) => {
    const before = req.params.id ? store.findOrder(req.params.id) : null;
    const wasWaiting = before ? readyToServe(before) : false;
    const order = fn(req);
    broadcast([order.table]);
    if (soundForKitchen && soundForKitchen(order)) io.to('kitchen').emit('ding', { type: 'kitchen', table: order.table });
    if (!wasWaiting && readyToServe(order)) io.to('reception').emit('ding', { type: 'ready', table: order.table });
    return { ok: true };
  });
}

const hasTodoKitchen = (o) => o.lines.some((l) => l.station === 'kitchen' && l.status === 'todo');

app.post('/api/orders/:id/approve', reception, orderAction((req) => store.approveOrder(req.params.id), hasTodoKitchen));
app.post('/api/orders/:id/reject', reception, orderAction((req) => store.rejectOrder(req.params.id, req.body?.reason)));
app.post(
  '/api/orders/:id/lines/:lineId/qty',
  reception,
  orderAction((req) => store.setLineQty(req.params.id, req.params.lineId, req.body?.qty), (o) => o.kitchenAlert)
);
app.post(
  '/api/orders/:id/lines/:lineId/cancel',
  reception,
  orderAction((req) => store.cancelLine(req.params.id, req.params.lineId), (o) => o.kitchenAlert)
);
app.post('/api/orders/:id/lines', reception, orderAction((req) => store.addLines(req.params.id, req.body?.lines), (o) => o.kitchenAlert));
app.post(
  '/api/tables/:table/orders',
  reception,
  orderAction((req) => store.placeStaffOrder(req.params.table, req.body || {}), hasTodoKitchen)
);

app.post('/api/orders/:id/served', reception, orderAction((req) => store.markServed(req.params.id)));

app.post(
  '/api/tables/:table/close',
  reception,
  handle((req) => {
    store.closeTable(req.params.table);
    // "closed" goes first so guest phones still know they had orders when they show the thank-you message
    io.to(`table:${req.params.table}`).emit('closed');
    broadcast([req.params.table]);
  })
);

app.post(
  '/api/calls/:id/resolve',
  reception,
  handle((req) => {
    const call = store.resolveCall(req.params.id);
    broadcast([call.table]);
  })
);

app.post(
  '/api/items/:id/sold-out',
  reception,
  handle((req) => {
    store.setSoldOut(req.params.id, Boolean(req.body?.soldOut));
    io.emit('soldOut', store.receptionView().soldOut);
    broadcast();
  })
);

app.post(
  '/api/settings/tables',
  reception,
  handle((req) => {
    store.setTableCount(req.body?.count);
    broadcast();
  })
);

app.get(
  '/api/qr-codes',
  reception,
  handle(async (req, res) => {
    const list = await Promise.all(
      store.tableCodes().map(async (t) => {
        const url = tableUrl(req, t);
        return { table: t.table, url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
      })
    );
    res.json({ tables: list });
  })
);

// ---------- kitchen / preparation API ----------

app.post(
  '/api/orders/:id/lines/:lineId/ready',
  kitchen,
  orderAction((req) => store.setLineReady(req.params.id, req.params.lineId, Boolean(req.body?.ready), req.role))
);
app.post('/api/orders/:id/ready', kitchen, orderAction((req) => store.setStationReady(req.params.id, req.body?.station, req.role)));
app.post('/api/orders/:id/seen', kitchen, orderAction((req) => store.ackKitchenChanges(req.params.id)));
app.post('/api/orders/:id/reopen', kitchen, orderAction((req) => store.reopenForKitchen(req.params.id)));

// ---------- demo helpers ----------

app.get('/api/demo', async (req, res) => {
  if (!DEMO_MODE) return res.status(404).json({ error: 'not_found' });
  const tables = await Promise.all(
    store
      .tableCodes()
      .slice(0, 4)
      .map(async (t) => {
        const url = tableUrl(req, t);
        return { table: t.table, url, path: `/t/${t.table}/${t.code}`, svg: await QRCode.toString(url, { type: 'svg', margin: 1 }) };
      })
  );
  res.json({ tables, pins: PINS, base: publicBase(req) });
});

app.post('/api/demo/reset', (req, res) => {
  if (!DEMO_MODE) return res.status(404).json({ error: 'not_found' });
  store.resetDemo();
  io.emit('closed');
  broadcast(store.tableCodes().map((t) => t.table));
  res.json({ ok: true });
});

// ---------- pages ----------

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', DEMO_MODE ? page('demo.html') : (req, res) => res.redirect('/reception'));
app.get('/t/:table/:code', page('menu.html'));
app.get('/kitchen', page('kitchen.html'));
app.get('/reception', page('reception.html'));
app.get('/qr', page('qr.html'));
// Photos rarely change and can be cached; code and styles are revalidated so updates reach phones immediately.
app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', /\.(jpe?g|png|webp|svg)$/i.test(file) ? 'public, max-age=86400' : 'no-cache');
    },
  })
);

// ---------- live updates ----------

io.on('connection', (socket) => {
  socket.on('join', (msg = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      if (msg.type === 'table') {
        store.assertTable(String(msg.table), String(msg.code));
        socket.join(`table:${msg.table}`);
        return reply({ ok: true, state: store.guestView(String(msg.table)) });
      }
      const role = sessionRole(socket.handshake.headers.cookie);
      if (msg.type === 'kitchen' && canUse(role, 'kitchen')) {
        socket.join('kitchen');
        return reply({ ok: true, state: store.kitchenView() });
      }
      if (msg.type === 'reception' && canUse(role, 'reception')) {
        socket.join('reception');
        return reply({ ok: true, state: store.receptionView() });
      }
      reply({ ok: false, error: 'login_required' });
    } catch (err) {
      reply({ ok: false, error: err.code || 'server_error' });
    }
  });
});

server.listen(PORT, () => {
  const lan = lanAddress();
  console.log(`\nBoranı ordering is running`);
  console.log(`  On this computer:   http://localhost:${PORT}`);
  console.log(`  From phones (Wi-Fi): http://${lan}:${PORT}`);
  console.log(`  Kitchen PIN ${PINS.kitchen} · Reception PIN ${PINS.reception}\n`);
});
