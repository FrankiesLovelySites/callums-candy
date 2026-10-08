import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { unlinkSync } from "node:fs";
import test, { after, before } from "node:test";

const databasePath = path.join(tmpdir(), `callums-candy-${randomBytes(12).toString("hex")}.sqlite`);
process.env.SHOP_DB_PATH = databasePath;
const { app, createAdminUser, db } = await import("../server.mjs");
let server;
let baseUrl;
let adminCookie;
let csrfToken;

async function request(route, { method = "GET", body, cookie, csrf, origin = true } = {}) {
	const headers = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (cookie) headers.Cookie = cookie;
	if (csrf) headers["X-CSRF-Token"] = csrf;
	if (origin) headers.Origin = baseUrl;
	const response = await fetch(`${baseUrl}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { response, data: await response.json() };
}

before(async () => {
	server = app.listen(0, "127.0.0.1");
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
	db.prepare("UPDATE products SET price_pence = 250, stock_quantity = 5 WHERE id = 1").run();
	await createAdminUser("shop-owner", "a-long-test-password");
});

after(async () => {
	if (server) await new Promise((resolve) => server.close(resolve));
	db.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${databasePath}${suffix}`);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
});

test("serves inventory without leaking database files or exact stock counts", async () => {
	const { response, data } = await request("/api/products", { origin: false });
	assert.equal(response.status, 200);
	assert.equal(data.products.length, 5);
	assert.equal(data.products[0].pricePence, 250);
	assert.equal(data.products[0].inStock, 1);
	assert.equal("stockQuantity" in data.products[0], false);
	assert.equal((await request("/data/shop.sqlite", { origin: false })).response.status, 404);
	assert.equal((await request("/server.mjs", { origin: false })).response.status, 404);
});

test("requires admin authentication and a CSRF token for inventory changes", async () => {
	const unauthorized = await request("/api/admin/products/1", {
		method: "PATCH",
		body: { pricePence: 300, stockQuantity: 5 }
	});
	assert.equal(unauthorized.response.status, 401);

	const login = await request("/api/admin/login", {
		method: "POST",
		body: { username: "SHOP-OWNER", password: "a-long-test-password" }
	});
	assert.equal(login.response.status, 200);
	adminCookie = login.response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
	csrfToken = login.data.csrfToken;
	assert.ok(adminCookie.includes("cc_admin="));
	assert.ok(adminCookie.includes("cc_csrf="));

	const noCsrf = await request("/api/admin/products/1", {
		method: "PATCH",
		cookie: adminCookie,
		body: { pricePence: 300, stockQuantity: 5 }
	});
	assert.equal(noCsrf.response.status, 403);

	const update = await request("/api/admin/products/1", {
		method: "PATCH",
		cookie: adminCookie,
		csrf: csrfToken,
		body: { pricePence: 250, stockQuantity: 5 }
	});
	assert.equal(update.response.status, 200);
	assert.equal(update.data.product.stockQuantity, 5);
});

test("creates an unpaid order using server prices and atomically reserves stock", async () => {
	const created = await request("/api/orders", {
		method: "POST",
		body: {
			name: "Test Customer",
			email: "customer@example.com",
			phone: "0123456789",
			address1: "1 Test Street",
			town: "Teston",
			postcode: "TE1 2ST",
			items: [{ productId: 1, quantity: 2, pricePence: 1 }]
		}
	});
	assert.equal(created.response.status, 201);
	assert.equal(created.data.totalPence, 450);
	assert.equal(created.data.shippingStatus, "to_be_confirmed");
	assert.match(created.data.orderNumber, /^CC-\d{8}-\d{6}$/);
	assert.equal(db.prepare("SELECT stock_quantity FROM products WHERE id = 1").get().stock_quantity, 3);

	const orders = await request("/api/admin/orders", { cookie: adminCookie, origin: false });
	assert.equal(orders.response.status, 200);
	assert.equal(orders.data.orders.length, 1);
	assert.equal(orders.data.orders[0].status, "new");
	assert.equal(orders.data.orders[0].totalPence, 450);
	assert.deepEqual(orders.data.orders[0].address, {
		address1: "1 Test Street",
		town: "Teston",
		postcode: "TE1 2ST"
	});
});

test("rejects requests above available stock without changing the inventory", async () => {
	const result = await request("/api/orders", {
		method: "POST",
		body: {
			name: "Test Customer",
			email: "customer@example.com",
			phone: "0123456789",
			address1: "1 Test Street",
			town: "Teston",
			postcode: "TE1 2ST",
			items: [{ productId: 1, quantity: 99 }]
		}
	});
	assert.equal(result.response.status, 409);
	assert.equal(db.prepare("SELECT stock_quantity FROM products WHERE id = 1").get().stock_quantity, 3);
});

test("cancelling an order restocks its items and blocks cross-origin admin requests", async () => {
	const order = db.prepare("SELECT id FROM orders ORDER BY id DESC LIMIT 1").get();
	const crossOrigin = await request(`/api/admin/orders/${order.id}`, {
		method: "PATCH",
		cookie: adminCookie,
		csrf: csrfToken,
		origin: false,
		body: { status: "cancelled" }
	});
	assert.equal(crossOrigin.response.status, 403);

	const cancelled = await request(`/api/admin/orders/${order.id}`, {
		method: "PATCH",
		cookie: adminCookie,
		csrf: csrfToken,
		body: { status: "cancelled" }
	});
	assert.equal(cancelled.response.status, 200);
	assert.equal(db.prepare("SELECT stock_quantity FROM products WHERE id = 1").get().stock_quantity, 5);
});

test("applies free shipping only when the discounted total is greater than £40", async () => {
	const placeSingleItemOrder = async () => request("/api/orders", {
		method: "POST",
		body: {
			name: "Test Customer",
			email: "customer@example.com",
			phone: "0123456789",
			address1: "1 Test Street",
			town: "Teston",
			postcode: "TE1 2ST",
			items: [{ productId: 1, quantity: 1 }]
		}
	});

	db.prepare("UPDATE products SET price_pence = 4445, stock_quantity = 5 WHERE id = 1").run();
	const exactThreshold = await placeSingleItemOrder();
	assert.equal(exactThreshold.data.totalPence, 4000);
	assert.equal(exactThreshold.data.shippingStatus, "to_be_confirmed");

	const cancelOrder = (orderNumber) => {
		const order = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(orderNumber);
		return request(`/api/admin/orders/${order.id}`, {
			method: "PATCH",
			cookie: adminCookie,
			csrf: csrfToken,
			body: { status: "cancelled" }
		});
	};
	assert.equal((await cancelOrder(exactThreshold.data.orderNumber)).response.status, 200);

	db.prepare("UPDATE products SET price_pence = 4446, stock_quantity = 5 WHERE id = 1").run();
	const aboveThreshold = await placeSingleItemOrder();
	assert.equal(aboveThreshold.data.totalPence, 4001);
	assert.equal(aboveThreshold.data.shippingStatus, "free");
	assert.equal((await cancelOrder(aboveThreshold.data.orderNumber)).response.status, 200);
	db.prepare("UPDATE products SET price_pence = 250 WHERE id = 1").run();
});
