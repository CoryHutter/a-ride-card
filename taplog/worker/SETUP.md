# Connecting the shop invoice to WPS

This sets up the "middleman": a tiny free service that holds the WPS key so it never
sits inside the web page. It also saves tickets and each bike's service history.
Everything below works from an iPad in Safari. About 15 minutes, one time.

You need: the WPS API key you want to use (with fitment unlocked).

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

## 4. Add the WPS key and the shop password
Still in **taplog-shop**, then **Settings**, then **Variables and Secrets**, tap **Add** three times:

| Type   | Name             | Value |
|--------|------------------|-------|
| Secret | `WPS_TOKEN`      | the WPS API key |
| Secret | `SHOP_KEY`       | a password you make up for the shop's iPad |
| Text   | `ALLOWED_ORIGIN` | `https://coryhutter.github.io` |

Tap **Deploy**. Secrets can't be read back once saved, not even by you, which is the point.

## 5. Copy the middleman's address
On the **taplog-shop** overview page there is an address that looks like
`https://taplog-shop.something.workers.dev`. Copy it.

## 6. Hook up the iPad
1. Open https://coryhutter.github.io/a-ride-card/taplog/shop-invoice.html
2. Tap **Settings**. Under **WPS connection**, paste the address and type the shop password.
3. Tap **Test connection**. When it says Connected, tap **Save**.

The badge at the top switches from "Sample parts" to **Live WPS**.

## Good to know
- Prices: customer prices come from WPS retail. The shop-only cost comes from the account
  whose key is in step 4, so for a real shop, use **that shop's** WPS key.
- Changing the key later: step 4, edit `WPS_TOKEN`, Deploy. Nothing changes on the iPad.
- Updating the middleman's code later: step 2, items 3 to 5 again.
- The free plan allows about 1,000 saved tickets a day, far more than a small shop needs.
