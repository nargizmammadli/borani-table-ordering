// All ordering state and the rules for changing it.
// State lives in memory and is saved to a JSON file, so a restart keeps open tables.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR, sign } = require('./secret');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'menu.json'), 'utf8'));

const LIMITS = {
  linesPerOrder: 40,
  qtyPerLine: 20,
  lineNote: 200,
  orderNote: 300,
  pendingOrdersPerTable: 3,
  maxTables: 200,
};

// Quick-note buttons guests can tap instead of typing. Keys are stored, labels live in the browser.
const QUICK_NOTES = {
  food: ['no_onion', 'no_tomato', 'spicy', 'not_spicy', 'less_salt', 'no_sauce'],
  drink: ['no_ice', 'no_sugar', 'less_sugar', 'with_lemon'],
  dessert: ['after_meal', 'two_spoons'],
};

const categoriesById = new Map(menu.categories.map((c) => [c.id, c]));
const itemsById = new Map(menu.items.map((i) => [i.id, i]));

class StoreError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const newId = () => crypto.randomBytes(6).toString('hex');
// Derived from the secret key, so printed QR codes keep working after restarts and redeploys.
const tableCode = (n) => sign(`table:${n}`).slice(0, 8);

function emptyState(tableCount = Number(process.env.TABLE_COUNT) || 12) {
  return { settings: { tableCount }, soldOut: {}, bills: [], orders: [], calls: [], seq: 100 };
}

let state = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return emptyState();
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

// ---------- lookups ----------

function assertTable(table, code) {
  const n = Number(table);
  const valid = Number.isInteger(n) && n >= 1 && n <= state.settings.tableCount && String(n) === String(table);
  if (!valid) throw new StoreError('table_not_found', 404);
  if (code !== undefined && code !== tableCode(n)) throw new StoreError('table_not_found', 404);
}

const openBill = (table) => state.bills.find((b) => b.table === table && b.status === 'open');

const findOrder = (orderId) => state.orders.find((o) => o.id === orderId) || null;

function getOrder(orderId) {
  const order = findOrder(orderId);
  if (!order) throw new StoreError('order_not_found', 404);
  return order;
}

// A line is "done" for preparation once it is ready, whether or not it has reached the table yet.
const isDone = (line) => line.status === 'ready' || line.status === 'served';

function getLine(order, lineId) {
  const line = order.lines.find((l) => l.id === lineId);
  if (!line) throw new StoreError('line_not_found', 404);
  return line;
}

function billIsOpen(order) {
  const bill = state.bills.find((b) => b.id === order.billId);
  if (!bill || bill.status !== 'open') throw new StoreError('bill_closed');
}

const isSoldOut = (itemId) => Boolean(state.soldOut[itemId]);

// ---------- building lines ----------

function cleanText(value, max) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildLine(input, { byStaff = false } = {}) {
  const item = itemsById.get(String(input.itemId));
  if (!item) throw new StoreError('item_not_found');
  if (isSoldOut(item.id)) throw new StoreError('item_sold_out');
  const category = categoriesById.get(item.category);

  let variant = null;
  if (item.variants) {
    variant = item.variants.find((v) => v.id === String(input.variantId));
    if (!variant) throw new StoreError('variant_required');
  }

  const qty = Number(input.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > LIMITS.qtyPerLine) throw new StoreError('bad_quantity');

  const allowed = QUICK_NOTES[category.quickNotes] || [];
  const quickNotes = [...new Set(Array.isArray(input.quickNotes) ? input.quickNotes : [])].filter((k) => allowed.includes(k));

  return {
    id: newId(),
    itemId: item.id,
    variantId: variant ? variant.id : null,
    name: item.name,
    variantLabel: variant ? variant.label : null,
    categoryName: category.name,
    price: variant ? variant.price : item.price,
    qty,
    quickNotes,
    note: cleanText(input.note, LIMITS.lineNote),
    station: category.station,
    status: 'todo', // todo | ready | served | cancelled
    readyAt: null,
    change: null, // null | added | qty | cancelled  (shown to the kitchen until they tap "seen")
    prevQty: null,
    byStaff,
  };
}

function buildLines(inputs, opts) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new StoreError('empty_order');
  if (inputs.length > LIMITS.linesPerOrder) throw new StoreError('too_many_lines');
  return inputs.map((i) => buildLine(i, opts));
}

function ensureBill(table) {
  let bill = openBill(table);
  if (!bill) {
    bill = { id: newId(), table, status: 'open', openedAt: Date.now(), closedAt: null };
    state.bills.push(bill);
  }
  return bill;
}

function newOrder(table, lines, note, { byStaff }) {
  const bill = ensureBill(table);
  const now = Date.now();
  const order = {
    id: newId(),
    no: ++state.seq,
    table,
    billId: bill.id,
    createdAt: now,
    byStaff,
    status: byStaff ? 'approved' : 'pending', // pending | approved | rejected
    approvedAt: byStaff ? now : null,
    rejectedAt: null,
    rejectReason: '',
    note: cleanText(note, LIMITS.orderNote),
    kitchenAlert: false,
    kitchenReopened: false,
    kitchenDoneAt: null,
    barDoneAt: null,
    lines,
  };
  state.orders.push(order);
  return order;
}

// ---------- guest actions ----------

function placeGuestOrder(table, code, body) {
  assertTable(table, code);
  const bill = openBill(table);
  if (bill) {
    const pending = state.orders.filter((o) => o.billId === bill.id && o.status === 'pending').length;
    if (pending >= LIMITS.pendingOrdersPerTable) throw new StoreError('too_many_pending');
  }
  const lines = buildLines(body.lines);
  const order = newOrder(table, lines, body.note, { byStaff: false });
  save();
  return order;
}

function callStaff(table, code, { type, payMethod }) {
  assertTable(table, code);
  if (!['waiter', 'bill'].includes(type)) throw new StoreError('bad_call_type');
  const method = type === 'bill' && ['cash', 'card'].includes(payMethod) ? payMethod : null;
  let call = state.calls.find((c) => c.table === table && c.type === type && !c.doneAt);
  if (call) {
    call.payMethod = method || call.payMethod;
  } else {
    call = { id: newId(), table, type, payMethod: method, createdAt: Date.now(), doneAt: null };
    state.calls.push(call);
  }
  save();
  return call;
}

// ---------- reception actions ----------

function approveOrder(orderId) {
  const order = getOrder(orderId);
  if (order.status !== 'pending') throw new StoreError('not_pending');
  billIsOpen(order);
  if (!order.lines.some((l) => l.status !== 'cancelled')) throw new StoreError('empty_order');
  order.status = 'approved';
  order.approvedAt = Date.now();
  // Changes made while pending are not news for the kitchen: it has never seen this order.
  for (const l of order.lines) {
    l.change = null;
    l.prevQty = null;
  }
  save();
  return order;
}

function rejectOrder(orderId, reason) {
  const order = getOrder(orderId);
  if (order.status !== 'pending') throw new StoreError('not_pending');
  order.status = 'rejected';
  order.rejectedAt = Date.now();
  order.rejectReason = cleanText(reason, 200);
  save();
  return order;
}

function assertEditable(order, line) {
  if (order.status === 'rejected') throw new StoreError('order_rejected');
  billIsOpen(order);
  if (isDone(line)) throw new StoreError('line_ready');
  if (line.status === 'cancelled') throw new StoreError('line_cancelled');
}

function flagKitchen(order, line) {
  if (order.status === 'approved' && line.station === 'kitchen') order.kitchenAlert = true;
}

function setLineQty(orderId, lineId, qty) {
  const order = getOrder(orderId);
  const line = getLine(order, lineId);
  assertEditable(order, line);
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty < 0 || qty > LIMITS.qtyPerLine) throw new StoreError('bad_quantity');
  if (qty === 0) return cancelLine(orderId, lineId);
  if (qty === line.qty) return order;
  if (order.status === 'approved' && line.change !== 'added') {
    if (line.prevQty == null) line.prevQty = line.qty;
    line.change = line.prevQty === qty ? null : 'qty';
    if (line.change === null) line.prevQty = null;
  }
  line.qty = qty;
  flagKitchen(order, line);
  save();
  return order;
}

function cancelLine(orderId, lineId) {
  const order = getOrder(orderId);
  const line = getLine(order, lineId);
  assertEditable(order, line);
  line.status = 'cancelled';
  if (order.status === 'approved') line.change = 'cancelled';
  flagKitchen(order, line);
  finishIfDone(order);
  save();
  return order;
}

function addLines(orderId, inputs) {
  const order = getOrder(orderId);
  if (order.status === 'rejected') throw new StoreError('order_rejected');
  billIsOpen(order);
  const lines = buildLines(inputs, { byStaff: true });
  for (const line of lines) {
    if (order.status === 'approved') line.change = 'added';
    order.lines.push(line);
    flagKitchen(order, line);
  }
  if (lines.some((l) => l.station === 'kitchen')) order.kitchenDoneAt = null;
  if (lines.some((l) => l.station === 'bar')) order.barDoneAt = null;
  save();
  return order;
}

function placeStaffOrder(table, body) {
  assertTable(table);
  const lines = buildLines(body.lines, { byStaff: true });
  const order = newOrder(table, lines, body.note, { byStaff: true });
  save();
  return order;
}

function markServed(orderId) {
  const order = getOrder(orderId);
  const now = Date.now();
  for (const l of order.lines) {
    if (l.status === 'ready') {
      l.status = 'served';
      l.servedAt = now;
    }
  }
  save();
  return order;
}

function resolveCall(callId) {
  const call = state.calls.find((c) => c.id === callId);
  if (!call) throw new StoreError('call_not_found', 404);
  call.doneAt = call.doneAt || Date.now();
  save();
  return call;
}

function closeTable(table) {
  assertTable(table);
  const bill = openBill(table);
  if (!bill) throw new StoreError('no_open_bill');
  bill.status = 'closed';
  bill.closedAt = Date.now();
  for (const o of state.orders) {
    if (o.billId === bill.id && o.status === 'pending') {
      o.status = 'rejected';
      o.rejectedAt = Date.now();
      o.rejectReason = 'table_closed';
    }
  }
  for (const c of state.calls) if (c.table === table && !c.doneAt) c.doneAt = Date.now();
  save();
  return bill;
}

function setSoldOut(itemId, soldOut) {
  if (!itemsById.has(String(itemId))) throw new StoreError('item_not_found', 404);
  if (soldOut) state.soldOut[itemId] = true;
  else delete state.soldOut[itemId];
  save();
}

function setTableCount(count) {
  count = Number(count);
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.maxTables) throw new StoreError('bad_table_count');
  state.settings.tableCount = count;
  save();
}

// ---------- kitchen / preparation actions ----------

function finishIfDone(order) {
  const now = Date.now();
  for (const station of ['kitchen', 'bar']) {
    const lines = order.lines.filter((l) => l.station === station && l.status !== 'cancelled');
    const done = lines.every(isDone);
    const key = station === 'kitchen' ? 'kitchenDoneAt' : 'barDoneAt';
    if (done && !order[key]) order[key] = now;
    if (!done) order[key] = null;
  }
  if (order.kitchenDoneAt && !order.kitchenAlert) order.kitchenReopened = false;
}

function assertStation(role, station) {
  if (role === 'kitchen' && station !== 'kitchen') throw new StoreError('forbidden', 403);
}

function setLineReady(orderId, lineId, ready, role) {
  const order = getOrder(orderId);
  const line = getLine(order, lineId);
  assertStation(role, line.station);
  if (order.status !== 'approved') throw new StoreError('not_approved');
  if (line.status === 'cancelled') throw new StoreError('line_cancelled');
  if (line.status === 'served') throw new StoreError('line_served');
  line.status = ready ? 'ready' : 'todo';
  line.readyAt = ready ? Date.now() : null;
  if (!ready && line.station === 'kitchen') order.kitchenReopened = true;
  finishIfDone(order);
  save();
  return order;
}

function setStationReady(orderId, station, role) {
  const order = getOrder(orderId);
  if (!['kitchen', 'bar'].includes(station)) throw new StoreError('bad_station');
  assertStation(role, station);
  if (order.status !== 'approved') throw new StoreError('not_approved');
  const now = Date.now();
  for (const l of order.lines) {
    if (l.station !== station) continue;
    if (l.status === 'todo') {
      l.status = 'ready';
      l.readyAt = now;
    }
    if (station === 'kitchen') {
      l.change = null;
      l.prevQty = null;
    }
  }
  if (station === 'kitchen') {
    order.kitchenAlert = false;
    order.kitchenReopened = false;
  }
  finishIfDone(order);
  save();
  return order;
}

function ackKitchenChanges(orderId) {
  const order = getOrder(orderId);
  order.kitchenAlert = false;
  for (const l of order.lines) {
    if (l.station === 'kitchen') {
      l.change = null;
      l.prevQty = null;
    }
  }
  finishIfDone(order);
  save();
  return order;
}

function reopenForKitchen(orderId) {
  const order = getOrder(orderId);
  if (order.status !== 'approved') throw new StoreError('not_approved');
  order.kitchenReopened = true;
  save();
  return order;
}

// ---------- views ----------

function totals(orders) {
  let subtotal = 0;
  for (const o of orders) {
    if (o.status === 'rejected') continue;
    for (const l of o.lines) if (l.status !== 'cancelled') subtotal += l.price * l.qty;
  }
  const service = Math.round((subtotal * menu.restaurant.serviceChargePercent) / 100);
  return { subtotal, service, total: subtotal + service };
}

const ordersOfBill = (bill) => (bill ? state.orders.filter((o) => o.billId === bill.id) : []);

function guestView(table) {
  const bill = openBill(table);
  const orders = ordersOfBill(bill).map((o) => ({
    id: o.id,
    no: o.no,
    createdAt: o.createdAt,
    status: o.status,
    rejectReason: o.rejectReason,
    note: o.note,
    byStaff: o.byStaff,
    lines: o.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      name: l.name,
      variantLabel: l.variantLabel,
      price: l.price,
      qty: l.qty,
      quickNotes: l.quickNotes,
      note: l.note,
      status: l.status,
    })),
  }));
  const calls = state.calls
    .filter((c) => c.table === table && !c.doneAt)
    .map(({ id, type, payMethod, createdAt }) => ({ id, type, payMethod, createdAt }));
  return {
    table,
    billId: bill ? bill.id : null,
    orders: orders.reverse(),
    totals: totals(ordersOfBill(bill)),
    calls,
    soldOut: Object.keys(state.soldOut),
  };
}

function kitchenView() {
  const now = Date.now();
  const openBillIds = new Set(state.bills.filter((b) => b.status === 'open').map((b) => b.id));
  const visible = [];
  const recent = [];
  for (const o of state.orders) {
    if (o.status !== 'approved') continue;
    const lines = o.lines.filter((l) => l.station === 'kitchen' && (l.status !== 'cancelled' || l.change === 'cancelled'));
    if (lines.length === 0 && !o.kitchenAlert) continue;
    const card = {
      id: o.id,
      no: o.no,
      table: o.table,
      approvedAt: o.approvedAt,
      note: o.note,
      byStaff: o.byStaff,
      alert: o.kitchenAlert,
      doneAt: o.kitchenDoneAt,
      lines,
    };
    const hasTodo = lines.some((l) => l.status === 'todo');
    if (hasTodo || o.kitchenAlert || o.kitchenReopened) visible.push(card);
    else if (o.kitchenDoneAt && now - o.kitchenDoneAt < 3 * 60 * 60 * 1000 && (openBillIds.has(o.billId) || now - o.kitchenDoneAt < 30 * 60 * 1000))
      recent.push(card);
  }
  visible.sort((a, b) => a.approvedAt - b.approvedAt);
  recent.sort((a, b) => b.doneAt - a.doneAt);
  return { orders: visible, recent: recent.slice(0, 20), serverTime: now };
}

function receptionView() {
  const openBills = state.bills.filter((b) => b.status === 'open');
  const tables = [];
  for (let n = 1; n <= state.settings.tableCount; n++) {
    const bill = openBills.find((b) => b.table === String(n));
    const orders = ordersOfBill(bill);
    tables.push({
      table: String(n),
      billId: bill ? bill.id : null,
      openedAt: bill ? bill.openedAt : null,
      totals: totals(orders),
      pending: orders.filter((o) => o.status === 'pending').length,
      preparing: orders.some((o) => o.status === 'approved' && o.lines.some((l) => l.status === 'todo')),
    });
  }
  return {
    settings: state.settings,
    tables,
    orders: state.orders.filter((o) => openBills.some((b) => b.id === o.billId)),
    calls: state.calls.filter((c) => !c.doneAt),
    soldOut: Object.keys(state.soldOut),
    serverTime: Date.now(),
  };
}

function tableCodes() {
  const list = [];
  for (let n = 1; n <= state.settings.tableCount; n++) list.push({ table: String(n), code: tableCode(n) });
  return list;
}

function resetDemo() {
  state = emptyState(state.settings.tableCount);
  save();
}

module.exports = {
  menu,
  QUICK_NOTES,
  StoreError,
  findOrder,
  markServed,
  assertTable,
  placeGuestOrder,
  callStaff,
  approveOrder,
  rejectOrder,
  setLineQty,
  cancelLine,
  addLines,
  placeStaffOrder,
  resolveCall,
  closeTable,
  setSoldOut,
  setTableCount,
  setLineReady,
  setStationReady,
  ackKitchenChanges,
  reopenForKitchen,
  guestView,
  kitchenView,
  receptionView,
  tableCodes,
  resetDemo,
  isSoldOut,
};
