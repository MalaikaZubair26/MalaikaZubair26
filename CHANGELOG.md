# Changes made in this review

## Latest fix (this pass)
-4. **Fixed a crash that took down the entire server, not just one order.**
   `POST /api/orders` released its database client twice on two specific
   paths — an invalid product, or (much more commonly) a delivery order
   under the minimum — once explicitly in that early `return`, and again in
   the `finally` block that runs afterward regardless. `pg`'s connection
   pool throws on a double release, and since that throw happened outside
   any try/catch, Node's default behavior is to crash the *whole process* —
   taking the entire site offline for every customer, not just the person
   whose order triggered it, until someone manually restarted the server.
   Removed the redundant explicit `client.release()` calls (the `finally`
   already covers every path). Reproduced the exact crash with a mock DB
   client, confirmed the fix, and added `process.on('uncaughtException'
   /'unhandledRejection')` handlers as a safety net so a future bug of this
   shape logs an error instead of taking the whole restaurant offline.

-3. **Neon Cloud Postgres support merged in.** `db.js` and `setup.js` now
   detect `DATABASE_URL` (or a `PGHOST` containing `neon.tech`) and switch to
   an SSL connection automatically, without breaking the documented local
   Postgres setup when `DATABASE_URL` isn't present. `.env` is now filled in
   with a working Neon connection string. `setup.js` also skips its
   local-only "CREATE DATABASE" step for a cloud database (Neon doesn't
   support/need it), and no longer risks silently overriding the database
   named in a connection string.

-3.5. **Fixed the "delivery order gives an error" bug.** The minimum-order
   rule for home delivery was already implemented server-side (defaults to
   €10, editable in the admin panel as "Pedido mínimo" — this was already
   built, just not surfaced well) — but `public/app.js`'s `submitOrder()`
   was discarding the server's actual rejection reason and always showing a
   generic "Error creating order" alert, making the working rule look like a
   broken checkout. Now the real message (e.g. the €10 minimum) is shown.
   Also added a live delivery-fee/minimum note on the checkout form itself
   (shown as soon as "Entrega a domicilio" is selected, pulled from
   `/api/settings`), so customers see the minimum before hitting an error.

-2. **Admin panel can now change its own password.** Previously there was no
   way to rotate the admin password after `npm run setup` seeded it once —
   the only option was editing the database directly. Added a "🔒 Seguridad
   de la cuenta" section to the bottom of the admin panel (public/admin.html,
   public/admin.js) and a new `POST /api/admin/change-password` route
   (server.js, behind `requireAdmin` + current-password verification) that
   re-hashes and updates `admin_users.password_hash`. The kitchen PIN needed
   no equivalent change — it's read from the `KITCHEN_PIN` environment
   variable on every login, so changing it is just an env var + restart on
   whatever host you're using.

-1. **Real session tokens for admin & kitchen logins, and a previously-open
   kitchen API is now locked down.** Both logins used to hand back a single
   hardcoded string (`admin-session-ok` / `kitchen-session-ok`) that every
   request just compared against literally — anyone who saw that string once
   (e.g. in their browser's network tab) could use it forever, on any device,
   without a password or PIN. Worse, `GET /api/kitchen/orders` and
   `PUT /api/kitchen/orders/:id/status` had **no auth check at all**, so
   anyone with the URL could see every pending order (name, phone, address)
   and change order statuses.
   - server.js: added a real in-memory session store — each login generates
     a random 32-byte token (`crypto.randomBytes`) with a 12-hour expiry,
     checked via new `checkSession()` / `requireAdmin` / `requireKitchen`.
   - `requireKitchen` is now applied to both kitchen order routes.
   - Added a dedicated `loginLimiter` (10 attempts / 15 min per IP) on both
     `/api/admin/login` and `/api/kitchen/login`, separate from the general
     API rate limit, so the 4-digit kitchen PIN can't be brute-forced.
   - public/kitchen.html: was storing the login token but never sending it —
     `fetchOrders()` and `updateStatus()` now send it as `x-kitchen-token`,
     and a 401 response logs the screen back out to the PIN prompt.

0. **Removed the "Card" online payment simulation.** Payment is actually
   collected in person — riders carry a POS machine for card, or cash — so
   the fake "Procesando pago..." screen (which never charged anything and
   could look misleading in real use) is gone. The checkout dropdown is now
   just "Efectivo" / "Tarjeta" as a heads-up for whoever fulfills the order.
   That choice now also shows on the **kitchen display** and the **printed
   receipt** (💵/💳), so dispatch knows whether the rider needs to bring a
   card reader tap or expect cash. `payment_method` in the database changed
   from `cash_counter` to plain `cash` (server.js, setup.js, public/app.js,
   public/index.html, public/kitchen.html) — `npm run setup` will migrate
   any existing orders automatically.

0.5. **Kitchen invoice printing.** The old "🖨️ Imprimir" button printed a
   flat list of items with no per-item breakdown. The new "🧾 Factura" button
   (`printInvoice()` in public/kitchen.html) prints an itemized invoice:
   each product on its own line with unit price and line total, every
   selected option listed underneath with its own price, then subtotal,
   delivery fee and tax as separate lines (only when non-zero), grand total,
   and the payment method.

0. **Removed the "Card" online payment simulation.** Payment is actually
   collected in person — riders carry a POS machine for card, or cash — so
   the fake "Procesando pago..." screen (which never charged anything and
   could look misleading in real use) is gone. The checkout dropdown is now
   just "Efectivo" / "Tarjeta" as a heads-up for whoever fulfills the order.
   That choice now also shows on the **kitchen display** and the **printed
   receipt** (💵/💳), so dispatch knows whether the rider needs to bring a
   card reader tap or expect cash. `payment_method` in the database changed
   from `cash_counter` to plain `cash` (server.js, setup.js, public/app.js,
   public/index.html, public/kitchen.html) — `npm run setup` will migrate
   any existing orders automatically.

6. **Option groups & extras were create/delete-only — now fully editable.**
   Product name/price/description already had a working "Editar" button, but
   the little choice buttons inside a product (sizes, "Extras", the
   question text like "¿Quieres modificar tu hamburguesa?", the subtitle
   under it, and each individual extra like "Sin salsa" or "Coca Cola
   +€1.50") could previously only be **added or deleted** — never edited.
   That's why typos like "terneto", "gh", "us", "3 min" ended up stuck in
   the admin panel: the only way to fix a mistake was to delete and rebuild
   the whole group from scratch.
   - `server.js`: added `PUT /api/admin/option-groups/:id`.
   - `public/admin.js` / `public/admin.html`: added a "✏️ editar grupo" link
     next to "✕ eliminar grupo" that opens an inline edit form (title,
     subtitle, type, required, min/max) with Save/Cancel — and a "✏️" icon
     next to each individual option/extra to edit its name and price in
     place, using the `PUT /api/admin/options/:id` endpoint that already
     existed on the server but had no button wired up to it.
   - No data was changed or deleted — this only adds the missing edit
     controls. Your existing (messy) groups/options are still there; you
     can now clean them up with the new "editar" buttons instead of
     deleting and re-typing them.


1. **Security fix — price tampering.** `/api/orders` used to trust the `item_price`
   sent by the browser for every cart line. Anyone editing the network request
   could have checked out for €0. The server now recalculates every item's
   price itself from the product + selected options in the database
   (server.js, `POST /api/orders`).

2. **Auto-generated option wording**, matching your screenshots exactly:
   - A required single-choice group (e.g. "Elige la carne") now shows
     **"Elige un/a"** under the title automatically.
   - An optional group (e.g. modifiers) now shows **"Elige hasta N extras"**
     automatically, using whatever max you set (5, 99, 1, etc.).
   - You can still type your own subtitle in the admin panel if you want to
     override the auto text — leave it blank to use the automatic wording.
   (server.js `deriveSubtitle()`, applied on both the customer-facing and
   admin options endpoints.)

3. **New "combo step" option type** (`component`), for products like
   "17. OFERTA 3 DURUM" that need numbered steps (① Elige tu primer durum,
   ② segundo durum, ③ tercer durum, ④ Patatas menú, ⑤ Bebida menú). Pick
   "Paso de combo (component)" as the group type in admin and it renders with
   a numbered red circle, single-choice, just like the reference app
   (public/app.js, public/admin.js, public/styles.css).

5. **Full menu content from your screenshots**, not just 3 examples — added as
   more ready-made example products (again: only inserted if not already
   present, safe to re-run):
   - *Taco Individual* — meat choice + "¿Quieres modificar tu taco?" (5) +
     "hazlo menú por 1.5€ más" drink+fries bundle upsell.
   - *5. Menú Plato Arroz* — meat + modifiers + a free "Elige la bebida"
     drink choice (no upcharge), with the exact description text
     "Pollo, Ternera o Mixto, con Verduras, Arroz y Bebida".
   - *19. Oferta 3 Pita* — a second numbered-step combo alongside the
     existing 3 Durum one.
   - *Nuggets* — "Formato" (6/9 pcs) + menu-upsell, with the exact
     description "Elige entre 6 y 9 unidades o menú con 6 unidades con
     patatas y bebida".
   - *Hamburguesa Pollo* — modifiers (including the odd €9.00 "Sin salsa
     roja" from your screenshot — that's really there on the reference
     site, edit/remove it in admin if it's a mistake) + a €2.5 meal
     upsell + a €1.5 drink-only upsell.
   - *Pizza Prosciutto* — size (Mediana 28cm/Grande 32cm) + up to 5
     toppings at €1.00 each + drink upsell, with the exact description
     "Salsa Tomate, Mozzarella, Jamón Pavo, Queso Feta y Orégano".
   All of the drink lists (Coca Cola, Fanta, Aquarius, Nestea, Sprite,
   Agua) are shared through one editable list in `setup.js`, and every
   name/price is still just rows in `option_groups`/`options` — fully
   editable per-product from the admin panel afterwards.

## Descriptions/items added from your latest screenshots (setup.js)
7. **New item — "23. Taco Pollo" (€7.00).** Description: "Pechuga de Pollo,
   Patatas, Queso, Mozzarella y Salsa". Has its own "¿Quieres añadir algún
   extra a tu taco?" group (mozzarella/queso/salsa/patatas, €1.00 each), the
   same "¿Quieres modificar tu taco?" modifiers as the other tacos, and the
   €1.5 meal upsell.
8. **New item — "8. Bolitas de Pollo" (€3.00).** Description: "14 uds". Has
   a "¿Quieres hacerlo menú por tan solo 2 euros más?" upsell (fries + drink,
   €2.00). Your screenshot's own bundle list had a duplicated "Coca Cola
   Zero + Patatas" entry and two abbreviated ones ("Nestea L", "Nestea M") —
   I used the correct, consistent drink names (Nestea Limón / Nestea
   Maracuyá) instead of reproducing those typos, same as every other
   drink-bundle group in this file.
9. **Confirmed numbering/renamed to match the real site:**
   "Hamburguesa Pollo (ejemplo)" → **"6. Hamburguesa"**, and
   "Patatas Gratinadas Sin Carne" → **"22. Patatas Gratinadas Sin Carne"**.
   Same description/options as before, just the correct name.
   Pizza Prosciutto and the two numbered combos (17/19) already matched
   your screenshots exactly, so nothing changed there.

   ⚠️ These are changes to the **seed script** (`setup.js`), which only
   affects a fresh database or `node setup.js` re-run (it skips anything
   that already exists by name, so it's safe to re-run). It does **not**
   change your live running site by itself — if your live site already has
   its own version of these items, use the admin panel (now with full
   edit support, see below) to update them, or add the two brand-new items
   there directly.

## What I checked on the reference site
`donerkebabytacos.turbopos.es` is a Flutter web app (no readable HTML/CSS to
diff against programmatically), so the changes above are based directly on
your three screenshots rather than the live site's source.

## To apply this
Run `node setup.js` again after deploying — it won't touch your existing
categories/products/admin login, it only adds the three example products
above and the new `ofertas`/`sides` categories if they don't exist yet.
