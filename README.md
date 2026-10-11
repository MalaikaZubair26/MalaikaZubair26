# 🥙 donerkebabtacos

Online ordering + self-service kiosk web app for **Döner Kebab Tacos**, built with Node.js, Express, and PostgreSQL, styled after the GoMeal UI (yellow accents, white rounded cards).

This is now a **complete, feature-full build**: menu browsing with item customization, cart, checkout with a simulated card payment, live order tracking, a kitchen display, a full admin panel (including managing customization options), customer order history lookup, and self-service GDPR data deletion — all working end-to-end, no paid services required.

---

## 🧰 What you need before starting

1. **Node.js** (version 18 or higher) — https://nodejs.org (download the "LTS" version, click through the installer with default options)
2. **PostgreSQL** (version 14+) — https://www.postgresql.org/download/
   - During install, it will ask you to set a **password for the "postgres" user**. Write this down — you'll need it in step 3 below.
   - It will also ask for a **port** — keep the default `5432`.
3. **VS Code** — https://code.visualstudio.com/

You do **not** need Docker, Stripe, Twilio, or any paid service. Everything runs locally on your laptop.

---

## 📂 Step 1 — Get the project into VS Code

1. Unzip the project folder you downloaded (`donerkebabtacos.zip`) somewhere easy to find, like your Desktop.
2. Open **VS Code**.
3. Go to **File → Open Folder…** and select the unzipped `donerkebabtacos` folder.
4. Open the built-in terminal: **Terminal → New Terminal** (or press `` Ctrl+` ``).

---

## ⚙️ Step 2 — Install the project's code libraries

In the VS Code terminal, type:

```bash
npm install
```

Wait for it to finish (creates a `node_modules` folder — this is normal, don't touch it).

---

## 🔑 Step 3 — Set up your database connection

**This project already has a `.env` filled in for you, pointed at a Neon Cloud Postgres database** (a hosted, managed Postgres — no local install needed at all). If you're using this `.env` as-is:
1. You can skip straight to Step 4 — `DATABASE_URL` is already set, and `db.js`/`setup.js` detect it automatically and switch to a secure (SSL) cloud connection instead of looking for a local database.
2. You don't need PostgreSQL installed on your own computer at all for this path — Neon hosts it for you.
3. Just remember: whoever has this `.env` file has full access to your live database (it contains a real password), so don't post it publicly (e.g. in a public GitHub repo) or send it over an unencrypted channel.

**If you'd rather run Postgres locally instead** (e.g. for offline development):
1. In the file explorer (left side of VS Code), open the `.env` file.
2. Delete or comment out the `DATABASE_URL=...` line — its presence always takes priority over the local `PGHOST`/`PGUSER`/etc. settings below it.
3. Set `PGPASSWORD` to the password you set when installing PostgreSQL locally.
4. You can leave everything else in `.env` as-is for now (default admin login is `admin` / `admin123`, default kitchen PIN is `1234` — change these later for real use, using the "🔒 Seguridad de la cuenta" section described further down).

**Make sure PostgreSQL is actually running** before the next step (only applies to the local-Postgres path above — skip this if you're using Neon):
- **Windows**: PostgreSQL usually runs automatically as a service after install. You can check via the "Services" app (search "Services" in the Start menu) — look for "postgresql-x64-..." and confirm it says "Running".
- **Mac**: If you installed via Postgres.app, just open the Postgres.app icon. If you installed via Homebrew: run `brew services start postgresql`.

---

## 🏗️ Step 4 — Create the database and tables

Back in the VS Code terminal:

```bash
npm run setup
```

This will:
- Create a new database called `donerkebabtacos`
- Create all the required tables
- Fill in a starter Spanish menu (kebabs, tacos, burgers, drinks, bakery items) — but **only the first time**. Running this again later will never erase menu items you've edited in the admin panel.

If you see `✅ Setup complete!` — you're good. If you see an error instead, it's almost always the password in `.env` being wrong, or PostgreSQL not running (see Step 3).

---

## 🚀 Step 5 — Start the app

```bash
npm start
```

You should see:

```
🥙 donerkebabtacos server running at http://localhost:3000
```

Now open your web browser and go to:

| Page | URL |
|---|---|
| 🛒 Customer storefront | http://localhost:3000/ |
| 🍳 Kitchen display | http://localhost:3000/kitchen.html (PIN: `1234`) |
| 🔐 Admin dashboard | http://localhost:3000/admin.html (login: `admin` / `admin123`) |

To stop the server at any time, click into the terminal and press `Ctrl+C`.

---

## 🖥️ Kiosk mode

Open the storefront with a URL like:
```
http://localhost:3000/?table=05
```
or
```
http://localhost:3000/?kiosk=01
```
This shows the fullscreen "tap to start" welcome screen and tags any order placed with that table/kiosk number so the kitchen sees it. The cart automatically resets to Spanish after 60 seconds of no activity — handy for a shared tablet.

---

## 🌐 Switching languages

Click the **"ES | EN"** button top-right of the storefront to toggle between Spanish and English. To lock the whole site in Spanish only (hide the toggle), open `public/app.js` and change the very first line:

```js
const ENABLE_ENGLISH_TOGGLE = false;
```

---

## 🛠️ Everyday use after today

Once everything is installed, you only need to do this each time you want to work on it or show it to someone:

1. Make sure PostgreSQL is running (see Step 3).
2. In VS Code terminal: `npm start`
3. Open http://localhost:3000/

You do **not** need to run `npm install` or `npm run setup` again unless you delete the project or wipe the database.

---

## 🩹 Troubleshooting

| Problem | Fix |
|---|---|
| `npm run setup` fails with a password/auth error | Double check `PGPASSWORD` in `.env` matches your real PostgreSQL password |
| `npm run setup` says "connection refused" | PostgreSQL isn't running — start it (Step 3) |
| Storefront loads but shows no menu items | Server can't reach the database — check the terminal running `npm start` for red error text |
| Port 3000 already in use | Change `PORT=3000` to `PORT=3001` in `.env`, then restart with `npm start` |

---

## 🌍 Going live: how the kitchen display and admin panel work on a real website

Right now everything runs on `localhost`, which only your own laptop can see. To actually launch:

1. **Deploy the whole project to a host** — e.g. Render, Railway, or a small VPS — along with a hosted PostgreSQL database (most of those hosts offer one). This is the same `donerkebabtacos` folder, just running on a server instead of your laptop, sitting behind a real domain name with HTTPS.
2. **It's all one website, just different pages.** Once it's live at, say, `https://donerkebabtacos.com`:
   - Customers order at `https://donerkebabtacos.com/`
   - **Kitchen display**: whoever's cooking opens `https://donerkebabtacos.com/kitchen.html` on a tablet or laptop in the kitchen (or on their phone, since it works from anywhere with internet — handy if someone needs to check orders remotely), and logs in with the kitchen PIN. It polls for new orders automatically every 10 seconds — no separate app to install.
   - **Admin panel**: you manage the menu at `https://donerkebabtacos.com/admin.html` from any device, logging in with the admin username/password.
3. **These pages aren't linked from the storefront navigation**, so an average customer won't stumble onto them — but that alone was never real security (see the login fix below). Real protection is the login itself.
4. **Sessions now actually expire** (see below) — everyone logs in with their PIN/password each shift, or once every 12 hours, same as any normal website login.

---

## 🔒 Security fix in this update — admin & kitchen logins are now real sessions

Previously, both the admin panel and kitchen display checked for a single **fixed, hardcoded** value (`admin-session-ok` / `kitchen-session-ok`) instead of a real per-login token — meaning anyone who inspected the page's network requests could copy that fixed string and get in without ever knowing the password or PIN. The kitchen order list and status-update endpoints had **no check at all**.

This is now fixed:
- Logging in (admin or kitchen) generates a random, unguessable 64-character token tied to that one login, stored server-side with a 12-hour expiry.
- Every admin and kitchen API route checks that token against the server-side session list — a copied/guessed string with the old fixed value no longer works.
- The kitchen order list and status-update endpoints, which were previously open to anyone with the URL, now require a valid kitchen login too.
- Login attempts (admin and kitchen) are now rate-limited to 10 tries per 15 minutes per IP address, so the 4-digit kitchen PIN can't just be brute-forced.
- Restarting the server clears all sessions — whoever's logged in just logs back in, same as any site would ask after a while.

---

## 🔑 Changing the admin password and kitchen PIN after you're live

**Kitchen PIN** — this is just an environment variable (`KITCHEN_PIN`), not stored in the database. To change it, update `KITCHEN_PIN` in your host's environment variables (e.g. Render's "Environment" tab) and redeploy/restart — no code change needed. Anyone with the old PIN in their head is locked out the moment you do this.

**Admin password** — the admin panel now has a **"🔒 Seguridad de la cuenta"** section at the bottom of the page. Log in, scroll down, enter your current password and a new one (8+ characters), and save — no server access needed. Previously there was no way to do this without editing the database directly, which is worth knowing if you're on an older copy of this project.

## 🚚 Delivery fee & minimum order

This was already built in, but wasn't showing itself clearly — here's how it actually works:

- In the admin panel's "🏪 Store & Contact Info" section, **"Gastos de envío"** sets the delivery fee (defaults to €2.00) and **"Pedido mínimo"** sets the minimum subtotal required for home delivery (defaults to €10.00, which is what you asked for). Both are editable any time, and take effect on the next order placed — no restart needed.
- **The bug**: if a customer picked "Entrega a domicilio" (home delivery) with a cart under the minimum, the server was correctly rejecting the order and sending back a clear reason (e.g. "El pedido mínimo para entrega a domicilio es €10.00") — but the storefront was throwing that message away and just showing a generic "Error creating order" alert. That made a working minimum-order rule look like a broken checkout. Fixed: the real reason from the server now shows in the alert.
- Also added: as soon as a customer selects delivery, the checkout form now shows the current delivery fee and minimum order right there (pulled live from your settings) — before they try to check out, not just as an error afterward.

## 🧾 Printing an invoice

On the kitchen display, each order card now has a **"🧾 Factura"** button. It opens a print-ready, itemized invoice (sized for an 80mm receipt printer) showing:
- Order number, date/time, customer name/phone, and delivery/pickup/table info
- **Every product on its own line with its own unit price and line total**, and every selected extra/option listed underneath with its own price
- Subtotal, delivery fee and tax as separate lines (only shown when non-zero)
- Grand total and the customer's chosen payment method (cash or card)

---

## 📋 Full feature list

- Full GoMeal-style responsive UI (desktop 3-column, tablet, mobile with bottom cart bar)
- Spanish/English toggle with database-backed bilingual menu
- Browse categories & products, search, add to cart, adjust quantities
- **Item customization**: products can have option groups (e.g. "Choose your sauce" — required, single-select; "Extras" — optional, multi-select up to N), each with its own price modifier. Selecting options adjusts the item's price and shows up as a separate cart line. Two products are seeded with sample options (Chicken Kebab → sauces, Al Pastor Tacos → extras) so you can see it working right away.
- Checkout flow (name, phone, delivery/pickup/dine-in, payment method, GDPR checkbox)
- **Payment is collected in person, not online**: at checkout the customer just picks Cash or Card as a heads-up for whoever fulfills the order — riders carry a POS machine for card taps on delivery, and the counter/kitchen can see the choice too (shown on the kitchen display and printed receipt). No online payment gateway is involved, so there's nothing to configure and no processing fees on your end for this flow.
- Order creation with automatic 10% IVA tax + delivery fee calculation
- Live order status tracking (polling) with sound + browser notification when "Ready"
- **"Mis Pedidos" (My Orders)**: customers can look up their past orders by phone number from the storefront, and self-request deletion of their personal data (GDPR) right from that same panel — no admin needed.
- Kitchen Display System with PIN login, live order queue, status buttons, 80mm receipt printing
- Admin dashboard: password login, add/edit/delete products, toggle availability, bilingual fields, **and manage each product's option groups & options** (add/remove sauces, extras, sizes, etc. per item)
- Kiosk mode via `?table=` / `?kiosk=` URL params with inactivity auto-reset

## 🔮 Natural next steps (beyond this build)

- A real payment gateway (Stripe, Redsys, etc. — needs a paid merchant account, intentionally left out here)
- Emailed/texted order receipts (needs a paid email/SMS provider)
- Full customer accounts with password login (currently phone-number lookup only, which is standard for this kind of kiosk/ordering app)
