const loginPanel = document.querySelector("#login-panel");
const loginForm = document.querySelector("#login-form");
const loginNotice = document.querySelector("#login-notice");
const dashboard = document.querySelector("#dashboard");
const dashboardNotice = document.querySelector("#dashboard-notice");
const productsBody = document.querySelector("#products-body");
const ordersList = document.querySelector("#orders-list");
const adminUser = document.querySelector("#admin-user");
let csrfToken = "";

async function api(url, options = {}) {
	const headers = new Headers(options.headers || {});
	if (options.body) headers.set("Content-Type", "application/json");
	if (csrfToken && options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
	const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
	let result;
	try {
		result = await response.json();
	} catch {
		throw new Error("The server returned an unreadable response. Check that the shop server is running.");
	}
	if (!response.ok) throw new Error(result.error || "The request could not be completed.");
	return result;
}

function showDashboard(email) {
	loginPanel.hidden = true;
	dashboard.hidden = false;
	adminUser.textContent = email;
}

function showLogin() {
	dashboard.hidden = true;
	loginPanel.hidden = false;
	adminUser.textContent = "";
	csrfToken = "";
}

function addTextCell(row, value, className) {
	const cell = document.createElement("td");
	cell.textContent = value;
	if (className) cell.className = className;
	row.append(cell);
	return cell;
}

function renderProducts(products) {
	productsBody.replaceChildren();
	for (const product of products) {
		const row = document.createElement("tr");
		addTextCell(row, product.name);
		const fields = document.createElement("td");
		const fieldGrid = document.createElement("div");
		fieldGrid.className = "product-fields";
		const priceField = document.createElement("label");
		priceField.className = "product-field";
		const priceLabel = document.createElement("span");
		priceLabel.textContent = "Price (£)";
		const price = document.createElement("input");
		price.type = "number";
		price.min = "0.01";
		price.max = "100000";
		price.step = "0.01";
		price.value = (product.pricePence / 100).toFixed(2);
		price.setAttribute("aria-label", `${product.name} price in pounds`);
		priceField.append(priceLabel, price);
		const stockField = document.createElement("label");
		stockField.className = "product-field";
		const stockLabel = document.createElement("span");
		stockLabel.textContent = "Stock units";
		const stock = document.createElement("input");
		stock.type = "number";
		stock.min = "0";
		stock.max = "100000";
		stock.step = "1";
		stock.value = product.stockQuantity;
		stock.setAttribute("aria-label", `${product.name} stock units`);
		stockField.append(stockLabel, stock);
		fieldGrid.append(priceField, stockField);
		fields.append(fieldGrid);
		row.append(fields);
		const status = addTextCell(row, product.stockQuantity > 0 ? "In stock" : "Out of stock");
		status.className = `stock-status${product.stockQuantity > 0 ? "" : " out"}`;
		status.dataset.label = "Availability";
		const action = document.createElement("td");
		const save = document.createElement("button");
		save.className = "button save-product";
		save.type = "button";
		save.textContent = "Save";
		save.addEventListener("click", async () => {
			const priceValue = Number(price.value);
			const stockValue = Number(stock.value);
			if (!Number.isFinite(priceValue) || Math.round(priceValue * 100) < 1 || !Number.isSafeInteger(stockValue) || stockValue < 0) {
				dashboardNotice.textContent = "Enter a price of at least £0.01 and a whole-number stock quantity of zero or more.";
				return;
			}
			save.disabled = true;
			dashboardNotice.textContent = "";
			try {
				await api(`/api/admin/products/${product.id}`, {
					method: "PATCH",
					body: JSON.stringify({ pricePence: Math.round(priceValue * 100), stockQuantity: stockValue })
				});
				dashboardNotice.style.color = "#217346";
				dashboardNotice.textContent = `${product.name} saved.`;
				await loadProducts();
			} catch (error) {
				dashboardNotice.style.color = "#a33b3b";
				dashboardNotice.textContent = error.message;
			} finally {
				save.disabled = false;
			}
		});
		action.append(save);
		row.append(action);
		productsBody.append(row);
	}
}

function formatMoney(pence) {
	return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

function renderOrders(orders) {
	ordersList.replaceChildren();
	if (!orders.length) {
		const empty = document.createElement("p");
		empty.className = "muted";
		empty.textContent = "No order requests yet.";
		ordersList.append(empty);
		return;
	}
	for (const order of orders) {
		const card = document.createElement("article");
		card.className = "order-card";
		const top = document.createElement("div");
		top.className = "order-top";
		const title = document.createElement("h3");
		title.textContent = `${order.orderNumber} · ${order.customerName}`;
		const status = document.createElement("span");
		status.className = "status-pill";
		status.textContent = order.status;
		top.append(title, status);
		const contact = document.createElement("p");
		contact.textContent = `${order.email} · ${order.phone}`;
		const address = document.createElement("p");
		address.textContent = `${order.address.address1}, ${order.address.town}, ${order.address.postcode}`;
		const items = document.createElement("ul");
		for (const item of order.items) {
			const line = document.createElement("li");
			line.textContent = `${item.quantity} × ${item.name} — ${formatMoney(item.unitPricePence * item.quantity)}`;
			items.append(line);
		}
		const totals = document.createElement("p");
		totals.textContent = `Subtotal ${formatMoney(order.subtotalPence)} · Halloween offer −${formatMoney(order.discountPence)} · Total ${formatMoney(order.totalPence)} · Shipping ${order.shippingStatus === "free" ? "free" : "to be confirmed"} · Unpaid`;
		card.append(top, contact, address, items, totals);
		if (order.status === "new" || order.status === "processing") {
			const actions = document.createElement("div");
			actions.className = "order-actions";
			const select = document.createElement("select");
			select.setAttribute("aria-label", `Update status for ${order.orderNumber}`);
			for (const [value, label] of [["processing", "Processing"], ["fulfilled", "Fulfilled"], ["cancelled", "Cancel and restock"]]) {
				const option = document.createElement("option");
				option.value = value;
				option.textContent = label;
				option.selected = (order.status === "processing" && value === "processing") || (order.status === "new" && value === "processing");
				select.append(option);
			}
			const save = document.createElement("button");
			save.className = "button button-secondary";
			save.type = "button";
			save.textContent = "Update order";
			save.addEventListener("click", async () => {
				save.disabled = true;
				try {
					await api(`/api/admin/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ status: select.value }) });
					dashboardNotice.style.color = "#217346";
					dashboardNotice.textContent = `${order.orderNumber} updated.`;
					await loadDashboard();
				} catch (error) {
					dashboardNotice.style.color = "#a33b3b";
					dashboardNotice.textContent = error.message;
					save.disabled = false;
				}
			});
			actions.append(select, save);
			card.append(actions);
		}
		ordersList.append(card);
	}
}

async function loadProducts() {
	const result = await api("/api/admin/products");
	renderProducts(result.products);
}

async function loadOrders() {
	const result = await api("/api/admin/orders");
	renderOrders(result.orders);
}

async function loadDashboard() {
	await Promise.all([loadProducts(), loadOrders()]);
}

loginForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	loginNotice.textContent = "";
	const formData = new FormData(loginForm);
	const submit = loginForm.querySelector("button[type=submit]");
	submit.disabled = true;
	try {
		const session = await api("/api/admin/login", {
			method: "POST",
			body: JSON.stringify({ username: formData.get("username"), password: formData.get("password") })
		});
		csrfToken = session.csrfToken;
		showDashboard(session.email);
		loginForm.reset();
		await loadDashboard();
	} catch (error) {
		loginNotice.textContent = error.message;
	} finally {
		submit.disabled = false;
	}
});

document.querySelector("#refresh-orders").addEventListener("click", async () => {
	dashboardNotice.textContent = "";
	try {
		await loadDashboard();
		dashboardNotice.style.color = "#217346";
		dashboardNotice.textContent = "Shop information refreshed.";
	} catch (error) {
		dashboardNotice.style.color = "#a33b3b";
		dashboardNotice.textContent = error.message;
	}
});

document.querySelector("#logout-button").addEventListener("click", async () => {
	try {
		await api("/api/admin/logout", { method: "POST" });
		showLogin();
	} catch (error) {
		dashboardNotice.style.color = "#a33b3b";
		dashboardNotice.textContent = error.message;
	}
});

async function restoreAdminSession() {
	try {
		const session = await api("/api/admin/session");
		if (session.authenticated && session.csrfToken) {
			csrfToken = session.csrfToken;
			showDashboard(session.email);
			await loadDashboard();
		}
	} catch (error) {
		loginNotice.textContent = error.message;
	}
}

restoreAdminSession();
