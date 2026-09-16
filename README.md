# Boranı Fəvvarələr — QR table ordering (demo)

Guests scan the QR code on their table, order from their phone, and follow the order live.
Reception checks every order before it reaches the kitchen. The kitchen sees food orders on a wall screen.

| Screen | Address | Who uses it |
| --- | --- | --- |
| Guest menu | `/t/<table>/<code>` (from the QR code) | Guests, on their own phone |
| Reception | `/reception` (PIN) | Cashier / reception, on a tablet or PC at the counter |
| Kitchen | `/kitchen` (PIN) | Cooks, on a wall-mounted touchscreen |
| QR codes | `/qr` (reception login) | Print once, one per table |
| Demo launcher | `/` | For showing the demo (turn off with `DEMO_MODE=false`) |

## How an order flows

1. **Guest** scans the table QR → the table number is attached automatically. They pick dishes (size, quantity,
   quick notes such as "No onion", or a written note), then **Send order**.
2. **Reception** hears a chime and sees the order under *Waiting for approval* → **Approve**, **Edit** or **Reject**.
3. After approval, **food goes to the kitchen screen**. **Drinks and desserts stay at reception** (their *Bar* menu).
4. **Kitchen** taps each dish when it is ready (or **All ready**). Reception gets *Ready — take to table* → **Served**.
5. The **guest's phone** shows every item's status: waiting for confirmation → being prepared → ready → served.
6. **Changes:** if a guest asks the waiter to change something, reception opens the table and edits it.
   Items already marked **Ready are locked**. Other changes flash on the kitchen screen ("was 2", "NEW", "CANCELLED")
   until a cook taps **Got it**.
7. Guests can **call the waiter** or **ask for the bill** (cash / card). Reception closes the table after payment
   (bill includes the 10% service charge).

Also: sold-out switches (guests can't order sold-out items), reception can place orders for guests without phones,
AZ / EN / RU everywhere, sound alerts, "minutes waiting" colours on the kitchen screen.

## Run it on your computer

Requires Node.js 20+.

```bash
npm install
npm start
```

Open http://localhost:3000. The terminal also prints the address phones should use
(e.g. `http://192.168.1.20:3000`). Phones must be on the **same Wi-Fi**; the first time, Windows asks
whether to allow Node.js through the firewall — allow it on private networks.

Default PINs: **reception 2222**, **kitchen 1111**.

## Put it online (GitHub + Render, free)

1. Create a GitHub repository and push this folder.
2. On [render.com](https://render.com): **New → Blueprint** → choose the repository. `render.yaml` sets everything up.
3. Render gives a public address such as `https://borani-ordering.onrender.com`. QR codes use it automatically.

Free plan notes: the server sleeps after ~15 minutes without visitors (first visit then takes about a minute),
and orders are cleared when it restarts. Table QR codes stay valid because they are derived from `SESSION_SECRET`.
For real daily use, move to a paid instance with a persistent disk or a database.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Web server port |
| `RECEPTION_PIN` | `2222` | 4-digit PIN for reception (also opens the kitchen screen) |
| `KITCHEN_PIN` | `1111` | 4-digit PIN for the kitchen screen |
| `SESSION_SECRET` | generated into `data/session-secret` | Signs staff logins and derives table QR codes. **Changing it invalidates printed QR codes.** |
| `TABLE_COUNT` | `12` | Number of tables on first start (can be changed on the reception QR tab) |
| `PUBLIC_URL` | auto | Force the address printed in QR codes, e.g. `https://order.borani.az` |
| `DEMO_MODE` | `true` | Shows the demo launcher and PINs on `/` and allows resetting demo data |
| `DATA_DIR` | `./data` | Where `state.json` (open tables and orders) is saved |

## Menu

`data/menu.json` holds the menu imported from the restaurant's current online menu
(names in AZ/EN/RU, prices, photos). The demo includes a few items from every category.

```bash
npm run import-menu        # demo selection
npm run import-menu:all    # the whole menu
```

Pizzas listed per size on the old menu are merged into one dish with a size choice.

## Kitchen screen hardware

The kitchen screen is a web page, so any device with a modern browser works. Suggested:

- **Best:** a 15–22" Android all-in-one touchscreen made for restaurants/POS, wall-mounted.
- **Budget:** a 10–11" Android tablet in a splash-proof wall mount.
- **No touch:** a TV/monitor + mini PC; use a keyboard or bump bar.

Open `/kitchen`, enter the PIN, tap **Start screen** (turns on sound and keeps the screen awake),
then use full screen. Keep the device plugged in and on the restaurant Wi-Fi.

## Project layout

```
server.js            web server, API, live updates (Socket.IO), staff PIN login
src/store.js         orders, bills, calls and all rules (approval, locking ready items, kitchen alerts)
src/secret.js        secret key for logins and table codes
data/menu.json       imported menu
public/menu.html     guest phone app      (js/guest.js, css/guest.css)
public/reception.html reception screen    (js/reception.js, css/reception.css)
public/kitchen.html  kitchen screen       (js/kitchen.js, css/kitchen.css)
public/qr.html       printable QR codes
public/js/i18n.js    all interface text in AZ / EN / RU
scripts/import-menu.js  menu importer
```
