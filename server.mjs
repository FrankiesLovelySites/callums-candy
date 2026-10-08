import { randomBytes, createHash, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.SHOP_DATA_DIR || path.join(root, "data");
const configuredProxyHops = process.env.TRUST_PROXY_HOPS;
const trustProxyHops = configuredProxyHops === undefined ? 0 : Number(configuredProxyHops);
if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
	throw new Error("TRUST_PROXY_HOPS must be a whole number between 0 and 5.");
}
mkdirSync(dataDirectory, { recursive: true });
const databasePath = process.env.SHOP_DB_PATH || path.join(dataDirectory, "shop.sqlite");
export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
	CREATE TABLE IF NOT EXISTS products (
		id INTEGER PRIMARY KEY,
		slug TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		price_pence INTEGER NOT NULL CHECK (price_pence > 0),
		unit TEXT NOT NULL,
		category TEXT NOT NULL,
		art_class TEXT NOT NULL,
		art_text TEXT NOT NULL,
		stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS admin_users (
		id INTEGER PRIMARY KEY,
		email TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS admin_sessions (
		token_hash TEXT PRIMARY KEY,
		csrf_hash TEXT NOT NULL,
		admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
	CREATE TABLE IF NOT EXISTS orders (
		id INTEGER PRIMARY KEY,
		order_number TEXT NOT NULL UNIQUE,
		customer_name TEXT NOT NULL,
		email TEXT NOT NULL,
		phone TEXT NOT NULL,
		address_json TEXT NOT NULL,
		subtotal_pence INTEGER NOT NULL,
		discount_pence INTEGER NOT NULL,
		total_pence INTEGER NOT NULL,
		shipping_status TEXT NOT NULL CHECK (shipping_status IN ('free', 'to_be_confirmed')),
		status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'processing', 'fulfilled', 'cancelled')),
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS order_items (
		id INTEGER PRIMARY KEY,
		order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
		product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
		product_name TEXT NOT NULL,
		unit_price_pence INTEGER NOT NULL,
		quantity INTEGER NOT NULL CHECK (quantity > 0)
	);
	CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC);
	CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
`);

const initialProducts = [
	["jelly-bean-party", "Jelly Bean Party", "A bright, fruity handful in all your favourite colours.", 250, "100g", "fruity pick-mix", "art-jelly", "JELLY<br>BEANS", 25],
	["sour-splash-belts", "Sour Splash Belts", "Tangy, chewy belts with a zingy sugar sparkle.", 225, "100g", "sour", "art-fizz", "SOUR<br>BELTS", 20],
	["rainbow-drops", "Rainbow Drops", "Light, crunchy sweets with a crisp shell and a fruity centre.", 275, "100g", "fruity", "art-fruit", "RAINBOW<br>DROPS", 18],
	["fruit-garden-gummies", "Fruit Garden Gummies", "Soft, chewy fruit shapes in a mix of bright flavours.", 240, "100g", "fruity pick-mix", "art-gummies", "FRUITY<br>GUMMIES", 16],
	["sweet-surprise-box", "Sweet Surprise Box", "A mystery mix of fruity, fizzy and chewy favourites, picked just for you.", 850, "box", "mystery", "art-surprise", "SWEET<br>SURPRISE", 10]
];

const insertProduct = db.prepare(`
	INSERT OR IGNORE INTO products
		(slug, name, description, price_pence, unit, category, art_class, art_text, stock_quantity)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const seedProducts = db.transaction(() => {
	for (const product of initialProducts) insertProduct.run(...product);
});
seedProducts();

const app = express();
export { app };
app.disable("x-powered-by");
if (trustProxyHops > 0) app.set("trust proxy", trustProxyHops);
app.use(helmet({
	contentSecurityPolicy: {
		directives: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'"],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", "data:"],
			connectSrc: ["'self'"],
			objectSrc: ["'none'"],
			baseUri: ["'self'"],
			frameAncestors: ["'none'"],
			upgradeInsecureRequests: null
		}
	},
	referrerPolicy: { policy: "same-origin" }
}));
app.use(express.json({ limit: "20kb", type: "application/json" }));
app.use(cookieParser());
app.use((req, res, next) => {
	res.set("Cache-Control", "no-store");
	next();
});

const publicProducts = db.prepare(`
	SELECT id, slug, name, description, price_pence AS pricePence, unit, category, art_class AS artClass,
		art_text AS artText, (stock_quantity > 0) AS inStock
	FROM products ORDER BY id
`);
const adminProducts = db.prepare(`
	SELECT id, slug, name, description, price_pence AS pricePence, unit, category, art_class AS artClass,
		art_text AS artText, stock_quantity AS stockQuantity
	FROM products ORDER BY id
`);
const getAdminByEmail = db.prepare("SELECT id, email, password_hash AS passwordHash FROM admin_users WHERE email = ?");
const getSession = db.prepare(`
	SELECT s.token_hash AS tokenHash, s.csrf_hash AS csrfHash, s.admin_id AS adminId,
		s.expires_at AS expiresAt, a.email
	FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
	WHERE s.token_hash = ? AND s.expires_at > ?
`);
const saveSession = db.prepare("INSERT INTO admin_sessions (token_hash, csrf_hash, admin_id, expires_at) VALUES (?, ?, ?, ?)");
const deleteSession = db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?");

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function matchesHash(value, expectedHash) {
	if (typeof value !== "string" || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
	return timingSafeEqual(Buffer.from(sha256(value), "hex"), Buffer.from(expectedHash, "hex"));
}

function cookieOptions(maxAge) {
	return {
		httpOnly: true,
		sameSite: "strict",
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge
	};
}

function fail(res, status, message) {
	return res.status(status).json({ error: message });
}

function requireSameOrigin(req, res, next) {
	const origin = req.get("origin");
	const expectedOrigin = `${req.protocol}://${req.get("host")}`;
	if (!origin || origin !== expectedOrigin) return fail(res, 403, "Request origin could not be verified.");
	next();
}

function readSession(req) {
	const token = req.cookies?.cc_admin;
	if (!token || token.length > 128) return null;
	return getSession.get(sha256(token), Date.now()) || null;
}

function requireAdmin(req, res, next) {
	const session = readSession(req);
	if (!session) return fail(res, 401, "Please sign in to manage the shop.");
	req.adminSession = session;
	next();
}

function requireAdminMutation(req, res, next) {
	const headerToken = req.get("x-csrf-token");
	if (!matchesHash(headerToken, req.adminSession.csrfHash)) {
		return fail(res, 403, "Security token expired. Refresh the admin page and try again.");
	}
	next();
}

function orderView(order) {
	return {
		...order,
		address: JSON.parse(order.addressJson),
		items: db.prepare(`
			SELECT product_name AS name, unit_price_pence AS unitPricePence, quantity
			FROM order_items WHERE order_id = ? ORDER BY id
		`).all(order.id)
	};
}

const loginLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 8,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	message: { error: "Too many sign-in attempts. Wait 15 minutes and try again." }
});

app.get("/api/products", (req, res) => {
	res.json({ products: publicProducts.all() });
});

app.post("/api/orders", requireSameOrigin, rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 12,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	message: { error: "Too many order attempts. Please wait and try again." }
}), (req, res) => {
	const body = req.body;
	if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "Enter your order details.");
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
	const phone = typeof body.phone === "string" ? body.phone.trim() : "";
	const address1 = typeof body.address1 === "string" ? body.address1.trim() : "";
	const town = typeof body.town === "string" ? body.town.trim() : "";
	const postcode = typeof body.postcode === "string" ? body.postcode.trim() : "";
	if (name.length < 2 || name.length > 100) return fail(res, 400, "Enter your name (2–100 characters).");
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, "Enter a valid email address.");
	if (phone.length < 5 || phone.length > 40) return fail(res, 400, "Enter a phone number we can contact you on.");
	if (address1.length < 3 || address1.length > 160 || town.length < 2 || town.length > 100 || postcode.length < 3 || postcode.length > 16) {
		return fail(res, 400, "Enter your street address, town and postcode.");
	}
	if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) return fail(res, 400, "Your bag must contain between 1 and 20 different treats.");

	const requested = new Map();
	for (const line of body.items) {
		if (!line || !Number.isSafeInteger(line.productId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) {
			return fail(res, 400, "One or more basket quantities are invalid.");
		}
		requested.set(line.productId, (requested.get(line.productId) || 0) + line.quantity);
	}
	if ([...requested.values()].some((quantity) => quantity > 99)) return fail(res, 400, "A treat quantity cannot exceed 99.");

	try {
		const createOrder = db.transaction(() => {
			const products = [];
			let subtotalPence = 0;
			for (const [productId, quantity] of requested) {
				const product = db.prepare("SELECT id, name, price_pence AS pricePence, stock_quantity AS stockQuantity FROM products WHERE id = ?").get(productId);
				if (!product) throw new Error("PRODUCT_MISSING");
				if (product.stockQuantity < quantity) throw new Error(`OUT_OF_STOCK:${product.name}`);
				products.push({ ...product, quantity });
				subtotalPence += product.pricePence * quantity;
			}
			const discountPence = Math.round(subtotalPence * 0.1);
			const totalPence = subtotalPence - discountPence;
			const shippingStatus = totalPence > 4000 ? "free" : "to_be_confirmed";
			const orderNumber = `CC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomInt(100000, 999999)}`;
			const address = { address1, town, postcode };
			const insertOrder = db.prepare(`
				INSERT INTO orders (order_number, customer_name, email, phone, address_json, subtotal_pence,
					discount_pence, total_pence, shipping_status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			const result = insertOrder.run(orderNumber, name, email, phone, JSON.stringify(address), subtotalPence, discountPence, totalPence, shippingStatus);
			const insertItem = db.prepare(`
				INSERT INTO order_items (order_id, product_id, product_name, unit_price_pence, quantity) VALUES (?, ?, ?, ?, ?)
			`);
			const reduceStock = db.prepare("UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock_quantity >= ?");
			for (const product of products) {
				insertItem.run(result.lastInsertRowid, product.id, product.name, product.pricePence, product.quantity);
				if (reduceStock.run(product.quantity, product.id, product.quantity).changes !== 1) throw new Error(`OUT_OF_STOCK:${product.name}`);
			}
			return { orderNumber, totalPence, shippingStatus };
		});
		const order = createOrder();
		return res.status(201).json({
			orderNumber: order.orderNumber,
			totalPence: order.totalPence,
			shippingStatus: order.shippingStatus,
			message: "Your order request has been saved. Payment and any shipping fee will be confirmed by the shop."
		});
	} catch (error) {
		if (error.message === "PRODUCT_MISSING") return fail(res, 400, "A treat in your basket is no longer available. Refresh the shop and try again.");
		if (error.message.startsWith("OUT_OF_STOCK:")) return fail(res, 409, `${error.message.slice(13)} is no longer available in that quantity. Refresh the shop and try again.`);
		console.error("Could not create order:", error);
		return fail(res, 500, "We couldn't save your order right now. Please try again.");
	}
});

app.get("/api/admin/session", (req, res) => {
	const session = readSession(req);
	if (!session) return res.json({ authenticated: false });
	const csrfToken = req.cookies.cc_csrf;
	if (!matchesHash(csrfToken, session.csrfHash)) {
		return res.json({ authenticated: true, email: session.email, csrfToken: null });
	}
	return res.json({ authenticated: true, email: session.email, csrfToken });
});

app.post("/api/admin/login", requireSameOrigin, loginLimiter, (req, res) => {
	const usernameValue = typeof req.body?.username === "string" ? req.body.username : req.body?.email;
	const email = typeof usernameValue === "string" ? usernameValue.trim().toLowerCase() : "";
	const password = typeof req.body?.password === "string" ? req.body.password : "";
	if (!email || email.length > 254 || password.length > 200) return fail(res, 400, "Enter a valid username and password.");
	const admin = getAdminByEmail.get(email);
	const passwordHash = admin?.passwordHash || "$2b$12$C6UzMDM.H6dfI/f/IKcEe.8fMmn5mA5S4AeJKTVuDFNhILtFA8JH6";
	const passwordValid = bcrypt.compareSync(password, passwordHash);
	if (!admin || !passwordValid) return fail(res, 401, "Username or password is incorrect.");

	const token = randomBytes(32).toString("base64url");
	const csrfToken = randomBytes(32).toString("base64url");
	db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(Date.now());
	saveSession.run(sha256(token), sha256(csrfToken), admin.id, Date.now() + 8 * 60 * 60 * 1000);
	res.cookie("cc_admin", token, cookieOptions(8 * 60 * 60 * 1000));
	res.cookie("cc_csrf", csrfToken, { ...cookieOptions(8 * 60 * 60 * 1000), httpOnly: false });
	return res.json({ authenticated: true, email: admin.email, csrfToken });
});

app.post("/api/admin/logout", requireSameOrigin, requireAdmin, requireAdminMutation, (req, res) => {
	deleteSession.run(req.adminSession.tokenHash);
	res.clearCookie("cc_admin", cookieOptions(0));
	res.clearCookie("cc_csrf", { ...cookieOptions(0), httpOnly: false });
	return res.json({ authenticated: false });
});

app.get("/api/admin/products", requireAdmin, (req, res) => {
	res.json({ products: adminProducts.all() });
});

app.patch("/api/admin/products/:id", requireSameOrigin, requireAdmin, requireAdminMutation, (req, res) => {
	const productId = Number(req.params.id);
	const pricePence = req.body?.pricePence;
	const stockQuantity = req.body?.stockQuantity;
	if (!Number.isSafeInteger(productId) || !Number.isSafeInteger(pricePence) || pricePence < 1 || pricePence > 10000000) {
		return fail(res, 400, "Price must be between £0.01 and £100,000.");
	}
	if (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 100000) {
		return fail(res, 400, "Stock must be a whole number between 0 and 100,000.");
	}
	const result = db.prepare(`
		UPDATE products SET price_pence = ?, stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`).run(pricePence, stockQuantity, productId);
	if (result.changes !== 1) return fail(res, 404, "Product not found.");
	return res.json({ product: adminProducts.all().find((product) => product.id === productId) });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
	const orders = db.prepare(`
		SELECT id, order_number AS orderNumber, customer_name AS customerName, email, phone, address_json AS addressJson,
			subtotal_pence AS subtotalPence, discount_pence AS discountPence, total_pence AS totalPence,
			shipping_status AS shippingStatus, status, created_at AS createdAt
		FROM orders ORDER BY id DESC LIMIT 200
	`).all().map(orderView);
	return res.json({ orders });
});

app.patch("/api/admin/orders/:id", requireSameOrigin, requireAdmin, requireAdminMutation, (req, res) => {
	const orderId = Number(req.params.id);
	const nextStatus = req.body?.status;
	if (!Number.isSafeInteger(orderId) || !["processing", "fulfilled", "cancelled"].includes(nextStatus)) {
		return fail(res, 400, "Choose a valid order status.");
	}
	try {
		const updateOrder = db.transaction(() => {
			const order = db.prepare("SELECT id, status FROM orders WHERE id = ?").get(orderId);
			if (!order) throw new Error("ORDER_MISSING");
			if (order.status === "fulfilled" || order.status === "cancelled") throw new Error("ORDER_FINAL");
			if (nextStatus === "cancelled") {
				const items = db.prepare("SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?").all(orderId);
				const restoreStock = db.prepare("UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
				for (const item of items) {
					if (item.productId !== null) restoreStock.run(item.quantity, item.productId);
				}
			}
			db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(nextStatus, orderId);
		});
		updateOrder();
		return res.json({ status: nextStatus });
	} catch (error) {
		if (error.message === "ORDER_MISSING") return fail(res, 404, "Order not found.");
		if (error.message === "ORDER_FINAL") return fail(res, 409, "This order is already complete or cancelled.");
		console.error("Could not update order:", error);
		return fail(res, 500, "We couldn't update the order right now.");
	}
});

app.use((req, res, next) => {
	if (!["/", "/index.html", "/style.css", "/script.js", "/admin.html", "/admin.css", "/admin.js"].includes(req.path)) {
		return fail(res, 404, "Page not found.");
	}
	next();
});

app.use(express.static(root, {
	index: "index.html",
	dotfiles: "deny",
	etag: true,
	maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
	setHeaders(res, filePath) {
		if (path.basename(filePath) === "index.html" || path.basename(filePath) === "admin.html") {
			res.setHeader("Cache-Control", "no-store");
		}
	}
}));

app.use((error, req, res, next) => {
	if (res.headersSent) return next(error);
	if (error instanceof SyntaxError && error.status === 400 && "body" in error) return fail(res, 400, "Request body must be valid JSON.");
	console.error("Unhandled request error:", error);
	return fail(res, 500, "The server encountered an unexpected error.");
});

export async function createAdminUser(username, password) {
	const normalizedUsername = username.trim().toLowerCase();
	if (!normalizedUsername || normalizedUsername.length > 254 || /\s/.test(normalizedUsername)) {
		throw new Error("Enter a valid username.");
	}
	if (password.length < 12 || password.length > 200) {
		throw new Error("Use an admin password between 12 and 200 characters.");
	}
	const passwordHash = await bcrypt.hash(password, 12);
	try {
		db.prepare("INSERT INTO admin_users (email, password_hash) VALUES (?, ?)").run(normalizedUsername, passwordHash);
	} catch (error) {
		if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new Error("An admin account already exists for that username.");
		throw error;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const port = Number(process.env.PORT || 3000);
	const host = process.env.HOST || "127.0.0.1";
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
	app.listen(port, host, () => {
		console.log(`Callum's Candy is listening on ${host}:${port}`);
		if (host === "127.0.0.1" || host === "localhost") {
			console.log("This server listens on this computer only. Configure deployment and HTTPS before accepting public orders.");
		}
	});
}
