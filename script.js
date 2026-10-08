const bag = new Map();
const bagCount = document.querySelector("#bag-count");
const bagLink = document.querySelector(".bag-link");
const cartContent = document.querySelector("#cart-content");
const cartSubtotal = document.querySelector("#cart-subtotal");
const cartDiscount = document.querySelector("#cart-discount");
const cartTotal = document.querySelector("#cart-total");
const cartNote = document.querySelector("#cart-note");
const checkoutButton = document.querySelector("#checkout-button");
const orderForm = document.querySelector("#order-form");
const orderError = document.querySelector("#order-error");
const shippingNote = document.querySelector("#shipping-note");
const promoDialog = document.querySelector("#promo-dialog");
const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const productsById = new Map();

async function api(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
		credentials: "same-origin"
	});
	let result;
	try {
		result = await response.json();
	} catch {
		throw new Error("The shop returned an unreadable response.");
	}
	if (!response.ok) throw new Error(result.error || "The shop could not complete that request.");
	return result;
}

function renderProducts(products) {
	for (const product of products) {
		productsById.set(product.id, product);
		const card = document.querySelector(`.product-card .add-button[data-product-id="${product.id}"]`)?.closest(".product-card");
		if (!card) continue;
		const button = card.querySelector(".add-button");
		const stockStatus = card.querySelector(".stock-status");
		card.querySelector("h3").textContent = product.name;
		card.querySelector(".product-description").textContent = product.description;
		card.querySelector(".product-type").textContent = product.category.includes("mystery") ? "Mystery box" : product.category.includes("sour") ? "Sour & fizzy" : product.category.includes("pick-mix") ? "Pick & mix" : "Fruity favourite";
		const price = card.querySelector(".price");
		price.firstChild.textContent = `${currency.format(product.pricePence / 100)} `;
		price.querySelector("small").textContent = `/ ${product.unit}`;
		button.dataset.name = product.name;
		button.dataset.pricePence = String(product.pricePence);
		stockStatus.textContent = product.inStock ? "In Stock" : "Out of Stock";
		stockStatus.classList.toggle("out-of-stock", !product.inStock);
		button.disabled = !product.inStock;
		button.textContent = product.inStock ? "Add to bag +" : "Out of stock";
	}
	document.querySelector("#shop-error").textContent = "";
}

function renderBag() {
	const items = [...bag.values()];
	const quantity = items.reduce((total, item) => total + item.quantity, 0);
	const subtotalPence = items.reduce((total, item) => total + item.pricePence * item.quantity, 0);
	const discountPence = Math.round(subtotalPence * 0.1);
	const totalPence = subtotalPence - discountPence;
	const shippingGapPence = Math.max(0, 4001 - totalPence);
	bagCount.textContent = quantity;
	bagLink.setAttribute("aria-label", `Shopping bag, ${quantity} ${quantity === 1 ? "item" : "items"}`);
	cartSubtotal.textContent = currency.format(subtotalPence / 100);
	cartDiscount.textContent = `−${currency.format(discountPence / 100)}`;
	cartTotal.textContent = currency.format(totalPence / 100);
	checkoutButton.disabled = quantity === 0;
	checkoutButton.textContent = orderForm.hidden ? "Continue to order" : "Your details";
	shippingNote.textContent = totalPence > 4000
		? "Your order qualifies for free shipping."
		: `Free shipping on orders over £40. Add ${currency.format(shippingGapPence / 100)} to qualify. Shipping below that is confirmed by the shop.`;

	if (items.length === 0) {
		cartContent.innerHTML = '<div class="cart-empty"><span aria-hidden="true">+</span>Your bag is waiting for a treat.</div>';
		orderForm.hidden = true;
		return;
	}

	const list = document.createElement("ul");
	list.className = "cart-items";
	for (const item of items) {
		const row = document.createElement("li");
		row.className = "cart-item";
		const name = document.createElement("span");
		name.className = "cart-item-name";
		name.textContent = item.name;
		const total = document.createElement("span");
		total.className = "cart-item-total";
		total.textContent = currency.format(item.pricePence * item.quantity / 100);
		const controls = document.createElement("div");
		controls.className = "quantity-controls";
		const decrease = document.createElement("button");
		decrease.type = "button";
		decrease.textContent = "−";
		decrease.setAttribute("aria-label", `Remove one ${item.name}`);
		decrease.addEventListener("click", () => updateQuantity(item.id, -1));
		const count = document.createElement("span");
		count.textContent = `Qty ${item.quantity}`;
		const increase = document.createElement("button");
		increase.type = "button";
		increase.textContent = "+";
		increase.setAttribute("aria-label", `Add one ${item.name}`);
		increase.disabled = item.quantity >= 99;
		increase.addEventListener("click", () => updateQuantity(item.id, 1));
		controls.append(decrease, count, increase);
		row.append(name, total, controls);
		list.append(row);
	}
	cartContent.replaceChildren(list);
}

function updateQuantity(productId, change) {
	const item = bag.get(productId);
	if (!item) return;
	item.quantity += change;
	if (item.quantity <= 0) bag.delete(productId);
	renderBag();
}

document.querySelectorAll(".add-button").forEach((button) => {
	button.addEventListener("click", () => {
		if (button.disabled) return;
		const productId = Number(button.dataset.productId);
		const product = productsById.get(productId);
		if (!product) {
			cartNote.textContent = "This product is not available right now. Refresh the shop and try again.";
			return;
		}
		const item = bag.get(productId);
		if (item) item.quantity = Math.min(99, item.quantity + 1);
		else bag.set(productId, { id: productId, name: product.name, pricePence: product.pricePence, quantity: 1 });
		renderBag();
		cartNote.textContent = `${product.name} added to your sweet bag.`;
		if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			button.animate(
				[{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }],
				{ duration: 240, easing: "ease-out" }
			);
		}
	});
});

checkoutButton.addEventListener("click", () => {
	if (bag.size === 0) return;
	orderForm.hidden = false;
	checkoutButton.textContent = "Your details";
	orderForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
	orderForm.querySelector("input").focus({ preventScroll: true });
});

orderForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	orderError.textContent = "";
	const submit = orderForm.querySelector("button[type=submit]");
	submit.disabled = true;
	cartNote.textContent = "Saving your unpaid order request…";
	const details = new FormData(orderForm);
	try {
		const result = await api("/api/orders", {
			method: "POST",
			body: JSON.stringify({
				name: details.get("name"),
				email: details.get("email"),
				phone: details.get("phone"),
				address1: details.get("address1"),
				town: details.get("town"),
				postcode: details.get("postcode"),
				items: [...bag.values()].map((item) => ({ productId: item.id, quantity: item.quantity }))
			})
		});
		bag.clear();
		orderForm.reset();
		orderForm.hidden = true;
		renderBag();
		cartNote.textContent = `Order ${result.orderNumber} received. The request is unpaid; the shop will confirm details by email or phone.`;
		try {
			const latestProducts = await api("/api/products");
			renderProducts(latestProducts.products);
		} catch (refreshError) {
			document.querySelector("#shop-error").textContent = `Your order was saved, but stock could not be refreshed: ${refreshError.message}`;
		}
	} catch (error) {
		orderError.textContent = error.message;
		cartNote.textContent = "Your order was not submitted. Check your details and try again.";
	} finally {
		submit.disabled = false;
	}
});

document.querySelectorAll(".filter-button").forEach((button) => {
	button.addEventListener("click", () => {
		const filter = button.dataset.filter;
		const cards = [...document.querySelectorAll(".product-card")];
		let visible = 0;
		for (const card of cards) {
			const matches = filter === "all" || card.dataset.category.split(" ").includes(filter);
			card.hidden = !matches;
			if (matches) visible += 1;
		}
		document.querySelectorAll(".filter-button").forEach((filterButton) => {
			filterButton.setAttribute("aria-pressed", String(filterButton === button));
		});
		document.querySelector("#filter-status").textContent = `Showing ${visible} ${filter === "all" ? "treats" : `${filter === "pick-mix" ? "pick-and-mix" : filter} treats`}`;
	});
});

document.querySelector("#promo-close").addEventListener("click", () => promoDialog.close());
document.querySelector("#promo-shop").addEventListener("click", () => {
	promoDialog.close();
	document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
});
window.setTimeout(() => {
	if (!promoDialog.open) promoDialog.showModal();
}, 650);

if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
	const observer = new IntersectionObserver((entries, revealObserver) => {
		for (const entry of entries) {
			if (entry.isIntersecting) {
				entry.target.classList.add("is-visible");
				revealObserver.unobserve(entry.target);
			}
		}
	}, { threshold: 0.12 });
	document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
} else {
	document.querySelectorAll(".reveal").forEach((element) => element.classList.add("is-visible"));
}

async function loadStorefrontProducts() {
	try {
		const result = await api("/api/products");
		renderProducts(result.products);
	} catch (error) {
		document.querySelector("#shop-error").textContent = `The shop could not load current prices and stock: ${error.message}`;
		document.querySelectorAll(".add-button").forEach((button) => {
			button.disabled = true;
			button.textContent = "Shop unavailable";
		});
	}
}

renderBag();
loadStorefrontProducts();