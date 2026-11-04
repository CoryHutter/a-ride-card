# Connecting the shop invoice to WPS

This sets up the "middleman": a tiny free service that holds the WPS key so it never
sits inside the web page. It also saves tickets and each bike's service history.
Everything below works from an iPad in Safari. About 15 minutes, one time.

You need: each shop's own WPS API key (with fitment unlocked). One middleman serves every shop.

## 1. Make a free Cloudflare account
Go to **dash.cloudflare.com** and sign up. The free plan is enough.

## 2. Create the middleman
1. In the left menu tap **Workers & Pages**, then **Create**, then **Create Worker**
   (pick "Hello World" if it asks).
2. Name it **taplog-shop** and tap **Deploy**.
3. Tap **Edit code**. Select everything in the editor and delete it.
4. Open this link in a new tab, select all the text, copy it, and paste it into the editor:
   https://raw.githubusercontent.com/CoryHutter/a-ride-card/main/taplog/worker/worker.js
5. Tap **Deploy**.

## 3. Give it a place to save tickets
1. Left menu: **Storage & Databases**, then **KV**, then **Create**.
   Name it **taplog-tickets**.
2. Go back to **Workers & Pages**, open **taplog-shop**, then **Settings**, then **Bindings**.
3. Tap **Add**, choose **KV namespace**.
   - Variable name: **TICKETS** (all capitals, exactly like that)
   - KV namespace: **taplog-tickets**
4. Tap **Deploy** / **Save**.

## 4. Add your two passwords
Still in **taplog-shop**, then **Settings**, then **Variables and Secrets**, tap **Add** three times:

| Type   | Name             | Value |
|--------|------------------|-------|
| Secret | `ADMIN_KEY`      | a password only you know, for the admin page |
| Secret | `MASTER_KEY`     | a long random phrase, like four or five unrelated words |
| Text   | `ALLOWED_ORIGIN` | `https://coryhutter.github.io` |

Tap **Deploy**. Secrets can't be read back once saved, not even by you, which is the point.

`MASTER_KEY` locks every shop's WPS and Parts Unlimited keys. **Write it down somewhere safe
and never change it.** If it changes, every shop's keys have to be entered again.

## 5. Copy the middleman's address
On the **taplog-shop** overview page there is an address that looks like
`https://taplog-shop.something.workers.dev`. Copy it.

## 6. Add a shop (do this for every shop)
1. Open https://coryhutter.github.io/a-ride-card/taplog/admin.html
2. Paste the middleman address and your `ADMIN_KEY`, tap **Show my shops**.
3. Tap **Add a shop**. Type the shop name; the shop ID and a password fill in by themselves.
4. Paste **that shop's own** WPS API key and tap **Test**. It should say the key works and fitment is on.
5. Parts Unlimited key: paste it if you have it. It's saved for when the invoice can use it.
6. Tap **Save shop**. A message appears with a setup link. Tap **Text it** and send it to the shop.

## 7. Hook up the shop's iPad
On the shop's iPad, tap the link from the text. The invoice opens, fills in the connection,
and the badge at the top switches from "Sample parts" to **Live WPS**.

To type it in instead: open the invoice, tap **Settings**, and under **WPS connection** enter
the middleman address, shop ID and password from the text, then **Test connection** and **Save**.

## Each shop is kept separate
- Every shop's parts cost comes from **its own** WPS key, so it sees its own discounts and lock-ins.
- WPS carts go on that shop's own WPS account.
- Each shop sees only its own tickets, invoice numbers and special-order history.
- One shop's password can't open another shop.
- To change a shop's key or password, or turn a shop off: admin page, **Edit**.

## Ordering parts from WPS
On a ticket, **Order parts from WPS** puts the ticket's WPS parts into a cart on the shop's
WPS account, with the invoice number as the PO. **Nothing is ordered** until someone opens
wpsorders.com and submits that cart, where shipping and warehouse can be changed too.
**Check order status** shows WPS's status, backorders and tracking once it's submitted.
The shop's WPS key must have ordering turned on by WPS.

## Good to know
- Prices: customer prices come from WPS retail. The shop-only cost comes from that shop's own key.
- Changing a shop's key later: admin page, **Edit**, paste the new key, Save. Nothing changes on the iPad.
- Already set up the old way, with `WPS_TOKEN` and `SHOP_KEY`? That shop keeps working with just its
  password and no shop ID. Add `ADMIN_KEY` and `MASTER_KEY` to start adding more shops.
- Updating the middleman's code later: step 2, items 3 to 5 again.
- The free plan allows about 1,000 saved tickets a day, far more than a small shop needs.
