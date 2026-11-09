(() => {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const WORKER_URL = ((window.APP_CONFIG || {}).workerUrl || "").replace(/\/$/, "");

  const view = document.getElementById("view");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rub = (n) => n.toLocaleString("ru-RU") + " ₽";

  let catalog = null;
  const products = {};
  let cart = {};
  let category = null;
  let screen = "list";
  let detailId = null;
  let doneOrderId = null;
  let busy = false;
  let mainHandler = null;
  const form = { name: "", phone: "", address: "", comment: "" };

  // ---------- корзина ----------
  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem("cart") || "{}");
      for (const [id, q] of Object.entries(raw)) {
        if (products[id] && q > 0) cart[id] = Math.min(Number(q) || 0, 20);
      }
    } catch (e) { /* хранилище недоступно */ }
  }
  function saveCart() {
    try { localStorage.setItem("cart", JSON.stringify(cart)); } catch (e) { /* ignore */ }
  }
  const count = () => Object.values(cart).reduce((a, b) => a + b, 0);
  const goodsSum = () => Object.entries(cart).reduce((s, [id, q]) => s + products[id].price * q, 0);
  const delivery = () => (count() > 0 ? Number(catalog.delivery_price) || 0 : 0);
  const totalSum = () => goodsSum() + delivery();

  function change(id, d) {
    const q = Math.max(0, Math.min(20, (cart[id] || 0) + d));
    if (q) cart[id] = q; else delete cart[id];
    saveCart();
    render();
  }

  // ---------- вспомогательное ----------
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function setMain(text, handler) {
    if (!tg) return;
    if (mainHandler) tg.MainButton.offClick(mainHandler);
    mainHandler = handler || null;
    if (text) {
      tg.MainButton.setText(text);
      if (handler) tg.MainButton.onClick(handler);
      tg.MainButton.show();
    } else {
      tg.MainButton.hide();
    }
  }

  function go(next, opts) {
    screen = next;
    if (opts && opts.id) detailId = opts.id;
    window.scrollTo(0, 0);
    render();
  }

  const img = (src) =>
    `<img src="${esc(src)}" loading="lazy" alt="" onerror="this.outerHTML='<div class=&quot;ph&quot;>🐱</div>'">`;
  const photoOrPh = (p) => (p.photos && p.photos.length ? img(p.photos[0]) : '<div class="ph">🐱</div>');

  function ctl(id) {
    const q = cart[id] || 0;
    if (!q) return `<button class="btn" data-a="inc" data-id="${esc(id)}">В корзину</button>`;
    return `<div class="step"><button data-a="dec" data-id="${esc(id)}">−</button><span>${q}</span><button data-a="inc" data-id="${esc(id)}">+</button></div>`;
  }

  // ---------- экраны ----------
  function viewList() {
    const tabs = catalog.categories.map((c) =>
      `<button class="tab ${c.id === category ? "on" : ""}" data-a="tab" data-id="${esc(c.id)}">${esc(c.title)}</button>`).join("");
    const cards = catalog.products.filter((p) => p.category === category).map((p) => `
      <div class="card">
        <div class="im" data-a="open" data-id="${esc(p.id)}">${photoOrPh(p)}</div>
        <div class="t" data-a="open" data-id="${esc(p.id)}">${esc(p.title)}</div>
        <div class="pr">${rub(p.price)}</div>
        <div class="ctl">${ctl(p.id)}</div>
      </div>`).join("");
    const bar = count()
      ? `<button class="btn cartbar" data-a="cart">Корзина · ${count()} шт · ${rub(goodsSum())}</button>` : "";
    return `<h1>${esc(catalog.shop_name)}</h1><div class="tabs">${tabs}</div><div class="grid">${cards}</div>${bar}`;
  }

  function viewDetail() {
    const p = products[detailId];
    const photos = p.photos && p.photos.length ? p.photos : [];
    const gallery = photos.length
      ? photos.map((src) => `<div class="slide">${img(src)}</div>`).join("")
      : '<div class="slide"><div class="ph">🐱</div></div>';
    return `<button class="back" data-a="list">← Каталог</button>
      <div class="gallery ${photos.length > 1 ? "" : "single"}">${gallery}</div>
      <h2>${esc(p.title)}</h2>
      <p><b>${rub(p.price)}</b></p>
      <p>${esc(p.description)}</p>
      <div class="detailctl">${ctl(p.id)}</div>
      ${count() ?`<button class="btn cartbar" data-a="cart">Корзина · ${count()} шт · ${rub(goodsSum())}</button>` : ""}`;
  }

  function viewCart() {
    if (!count()) {
      return `<button class="back" data-a="list">← Каталог</button><p class="muted center">Корзина пуста</p>`;
    }
    const lines = Object.entries(cart).map(([id, q]) => {
      const p = products[id];
      return `<div class="line">
        <div class="nm">${esc(p.title)}</div>
        <div class="step"><button data-a="dec" data-id="${esc(id)}">−</button><span>${q}</span><button data-a="inc" data-id="${esc(id)}">+</button></div>
        <div class="sm">${rub(p.price * q)}</div></div>`;
    }).join("");
    const d = delivery();
    return `<button class="back" data-a="list">← Каталог</button><h1>Корзина</h1>${lines}
      <div class="line dl"><div class="nm muted">Доставка</div><div class="sm">${d ? rub(d) : "—"}</div></div>
      <div class="total"><span>Итого</span><span>${rub(totalSum())}</span></div>
      <p class="muted">${esc(catalog.delivery_note || "")}</p>
      <button class="btn" data-a="checkout">Оформить заказ</button>`;
  }

  function viewCheckout() {
    return `<button class="back" data-a="cart">← Корзина</button><h1>Оформление</h1>
      <label>Имя и фамилия получателя</label>
      <input data-f="name" autocomplete="name" value="${esc(form.name)}">
      <label>Телефон</label>
      <input data-f="phone" type="tel" autocomplete="tel" placeholder="+7 900 123-45-67" value="${esc(form.phone)}">
      <label>Адрес доставки: город и улица либо пункт выдачи СДЭК/Почты</label>
      <textarea data-f="address">${esc(form.address)}</textarea>
      <label>Комментарий (необязательно)</label>
      <textarea data-f="comment">${esc(form.comment)}</textarea>
      <div class="total"><span>К оплате</span><span>${rub(totalSum())}</span></div>
      ${tg ? "" : '<p class="muted">Откройте магазин в Telegram, чтобы оплатить заказ.</p>'}`;
  }

  function viewDone() {
    return `<h1>Спасибо!</h1>
      <p>Заказ <b>№${esc(doneOrderId)}</b> оплачен. Мы свяжемся с вами по телефону и отправим заказ.</p>
      <button class="btn" data-a="list">В каталог</button>`;
  }

  function render() {
    // защита от ситуации, когда корзина опустела на экране оформления
    if ((screen === "checkout") && !count()) screen = "cart";
    const html = { list: viewList, detail: viewDetail, cart: viewCart, checkout: viewCheckout, done: viewDone }[screen]();
    view.innerHTML = html;
    if (screen === "checkout") setMain(`Оплатить ${rub(totalSum())}`, submit);
    else setMain(null);
  }

  // ---------- оформление ----------
  function validate() {
    if (form.name.trim().length < 2) return "Укажите имя получателя";
    if (form.phone.replace(/\D/g, "").length < 10) return "Укажите телефон, например +7 900 123-45-67";
    if (form.address.trim().length < 5) return "Укажите адрес доставки подробнее";
    return null;
  }

  async function submit() {
    if (busy) return;
    const err = validate();
    if (err) { toast(err); return; }
    if (!tg || !tg.initData) { toast("Откройте магазин в Telegram"); return; }
    busy = true;
    tg.MainButton.showProgress && tg.MainButton.showProgress();
    const stop = () => { busy = false; tg.MainButton.hideProgress && tg.MainButton.hideProgress(); };
    try {
      const r = await fetch(WORKER_URL + "/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initData: tg.initData,
          items: Object.entries(cart).map(([id, qty]) => ({ id, qty })),
          customer: { ...form },
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Не удалось создать заказ");
      tg.openInvoice(d.invoiceUrl, (status) => {
        stop();
        if (status === "paid") {
          cart = {}; saveCart();
          doneOrderId = d.orderId;
          go("done");
        } else if (status === "failed") {
          toast("Оплата не прошла. Попробуйте ещё раз.");
        } else if (status === "cancelled") {
          toast("Оплата отменена");
        }
      });
    } catch (e) {
      stop();
      toast(e.message || "Ошибка сети, попробуйте ещё раз");
    }
  }

  // ---------- события ----------
  view.addEventListener("click", (e) => {
    const el = e.target.closest("[data-a]");
    if (!el) return;
    const a = el.dataset.a;
    const id = el.dataset.id;
    if (a === "tab") { category = id; render(); }
    else if (a === "open") go("detail", { id });
    else if (a === "inc") change(id, 1);
    else if (a === "dec") change(id, -1);
    else if (a === "cart") go("cart");
    else if (a === "checkout") go("checkout");
    else if (a === "list") go("list");
  });
  view.addEventListener("input", (e) => {
    const f = e.target.dataset && e.target.dataset.f;
    if (f && f in form) form[f] = e.target.value;
  });

  // ---------- запуск ----------
  fetch("catalog.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((c) => {
      catalog = c;
      c.products.forEach((p) => { products[p.id] = p; });
      category = c.categories[0].id;
      loadCart();
      render();
    })
    .catch(() => { view.innerHTML = '<p class="muted center">Не удалось загрузить каталог. Попробуйте позже.</p>'; });
})();
