# Callum's Candy shop

The shop runs as a local Node.js app with a SQLite database. Product prices, inventory and unpaid order requests are managed at `/admin.html`.

## Run it on Windows

1. Install Node.js 22 or newer.
2. Open PowerShell in this folder and install the project dependencies:

   ```powershell
   npm install
   ```

3. Create the first administrator. Enter a unique username and a password with at least 12 characters; the password is not echoed in the terminal:

   ```powershell
   npm run admin:create
   ```

4. Start the shop:

   ```powershell
   npm start
   ```

5. Open the storefront at <http://localhost:3000> and shop management at <http://localhost:3000/admin.html>.

The shop creates its database at `data/shop.sqlite`. Keep this folder private and backed up. Never publish the database, administrator credentials, or `data` directory.

## How orders currently work

The customer checkout saves an order request and reserves the requested stock. The order is **unpaid**: there is no card collection or online payment integration. The shop owner must confirm payment and any shipping charge directly with the customer. Free shipping applies to totals greater than £40 after the displayed 10% offer; shipping for other orders is left to be confirmed. Cancelling an order in admin returns its items to stock.

This server binds to this computer only (`127.0.0.1`) by default. It is for local development and testing, not a public internet storefront. Before deployment, configure a hosting provider, HTTPS, a trusted reverse proxy, backups and monitoring. Behind a reverse proxy, set `HOST` to the private interface address, `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops, and `NODE_ENV=production`; do not trust arbitrary client-supplied proxy headers. Add a payment provider integration before accepting online payments. Do not expose the local admin portal or collect real customer orders until that production setup is complete.
