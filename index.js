// Cloudflare Worker: принимает заказы из Mini App, создаёт счёт на оплату,
// обрабатывает вебхук Telegram и присылает вам оплаченные заказы.

const enc = new TextEncoder();

// ---------- утилиты ----------

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const rub = (n) => n.toLocaleString("ru-RU") + " ₽";

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Проверка подписи данных, которые Telegram передаёт Mini App (initData).
async function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== "string") return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const calc = toHex(await hmac(secret, dataCheck));
  if (!safeEqual(calc, hash)) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
  if (!(age > -60 && age < 86400)) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

async function tgApi(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function loadCatalog(env) {
  const r = await fetch(env.CATALOG_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error("catalog");
  return r.json();
}

function newOrderId() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).toUpperCase();
}

// ---------- заказ из Mini App ----------

async function handleOrder(request, env) {
  let body;
  try { body = await request.json(); } catch { return json(env, { ok: false, error: "Некорректный запрос" }, 400); }

  const user = await validateInitData(body.initData, env.BOT_TOKEN);
  if (!user) return json(env, { ok: false, error: "Откройте магазин из Telegram" }, 403);

  const c = body.customer || {};
  const customer = {
    name: String(c.name || "").trim().slice(0, 100),
    phone: String(c.phone || "").trim().slice(0, 30),
    address: String(c.address || "").trim().slice(0, 300),
    comment: String(c.comment || "").trim().slice(0, 300),
  };
  if (customer.name.length < 2) return json(env, { ok: false, error: "Укажите имя" }, 400);
  if (customer.phone.replace(/\D/g, "").length < 10) return json(env, { ok: false, error: "Укажите телефон" }, 400);
  if (customer.address.length < 5) return json(env, { ok: false, error: "Укажите адрес" }, 400);

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
    return json(env, { ok: false, error: "Корзина пуста" }, 400);
  }

  let catalog;
  try { catalog = await loadCatalog(env); } catch { return json(env, { ok: false, error: "Каталог временно недоступен" }, 502); }
  const byId = Object.fromEntries(catalog.products.map((p) => [p.id, p]));

  // цены берём из каталога на сервере, а не из запроса клиента
  const items = [];
  const seen = new Set();
  for (const it of body.items) {
    const p = byId[it && it.id];
    const qty = Number(it && it.qty);
    if (!p || seen.has(p.id) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return json(env, { ok: false, error: "Некорректный состав заказа" }, 400);
    }
    seen.add(p.id);
    items.push({ id: p.id, title: p.title, price: p.price, qty });
  }
  const deliveryPrice = Number(catalog.delivery_price) || 0;
  const goods = items.reduce((s, i) => s + i.price * i.qty, 0);
  const total = goods + deliveryPrice;

  const orderId = newOrderId();
  const order = {
    id: orderId,
    user: { id: user.id, username: user.username || "", name: [user.first_name, user.last_name].filter(Boolean).join(" ") },
    items, deliveryPrice, total, customer,
    status: "created",
    createdAt: new Date().toISOString(),
  };
  await env.ORDERS.put(`order:${orderId}`, JSON.stringify(order));

  const prices = items.map((i) => ({
    label: `${i.title} × ${i.qty}`.slice(0, 60),
    amount: Math.round(i.price * i.qty * 100),
  }));
  if (deliveryPrice > 0) prices.push({ label: "Доставка", amount: Math.round(deliveryPrice * 100) });

  const description = items.map((i) => `${i.title} × ${i.qty}`).join(", ").slice(0, 250) || "Заказ";
  const inv = await tgApi(env, "createInvoiceLink", {
    title: `Заказ №${orderId}`.slice(0, 32),
    description,
    payload: orderId,
    provider_token: env.PROVIDER_TOKEN,
    currency: "RUB",
    prices,
  });
  if (!inv.ok) {
    console.log("createInvoiceLink failed", JSON.stringify(inv));
    return json(env, { ok: false, error: "Не удалось создать счёт. Попробуйте позже." }, 502);
  }
  return json(env, { ok: true, orderId, invoiceUrl: inv.result });
}

// ---------- вебхук Telegram ----------

function orderText(order, paid) {
  const lines = order.items.map((i) => `• ${esc(i.title)} × ${i.qty}`).join("\n");
  const who = order.user.username
    ? `@${esc(order.user.username)}`
    : `<a href="tg://user?id=${order.user.id}">${esc(order.user.name || "клиент")}</a>`;
  return (
    `<b>${paid ? "Оплаченный заказ" : "Заказ"} №${esc(order.id)}</b>\n\n` +
    `${lines}\n` +
    (order.deliveryPrice ? `Доставка: ${rub(order.deliveryPrice)}\n` : "") +
    `Сумма: <b>${rub(order.total)}</b>\n\n` +
    `Получатель: ${esc(order.customer.name)}\n` +
    `Телефон: ${esc(order.customer.phone)}\n` +
    `Адрес: ${esc(order.customer.address)}\n` +
    `Комментарий: ${esc(order.customer.comment) || "—"}\n` +
    `Telegram: ${who}`
  );
}

async function handleWebhook(request, env) {
  if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.WEBHOOK_SECRET || "")) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();

  // Telegram спрашивает, можно ли принять платёж (нужно ответить за 10 секунд)
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const raw = await env.ORDERS.get(`order:${q.invoice_payload}`);
    const order = raw ? JSON.parse(raw) : null;
    const ok = order && order.status !== "paid" && q.total_amount === Math.round(order.total * 100);
    await tgApi(env, "answerPreCheckoutQuery", ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: "Заказ не найден или уже оплачен. Оформите заказ заново." });
    return new Response("ok");
  }

  const msg = update.message;
  if (msg && msg.successful_payment) {
    const pay = msg.successful_payment;
    const key = `order:${pay.invoice_payload}`;
    const raw = await env.ORDERS.get(key);
    if (raw) {
      const order = JSON.parse(raw);
      if (order.status !== "paid") {
        order.status = "paid";
        order.paidAt = new Date().toISOString();
        order.chargeId = pay.provider_payment_charge_id || pay.telegram_payment_charge_id;
        await env.ORDERS.put(key, JSON.stringify(order));
        await tgApi(env, "sendMessage", { chat_id: env.ADMIN_ID, text: orderText(order, true), parse_mode: "HTML" });
        await tgApi(env, "sendMessage", {
          chat_id: msg.chat.id,
          text: `Оплата заказа №${order.id} получена, спасибо! Мы свяжемся с вами по телефону и отправим заказ.`,
        });
      }
    } else {
      // деньги пришли, а заказа нет в базе: сообщаем администратору
      await tgApi(env, "sendMessage", {
        chat_id: env.ADMIN_ID,
        text: `Пришла оплата, но заказ ${esc(pay.invoice_payload)} не найден. Клиент: ${msg.chat.id}. Сумма: ${pay.total_amount / 100} ${esc(pay.currency)}.`,
        parse_mode: "HTML",
      });
    }
    return new Response("ok");
  }

  if (msg && msg.chat && msg.chat.type === "private" && typeof msg.text === "string" && msg.text.startsWith("/start")) {
    await tgApi(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "Добро пожаловать в «Лапки к Лапкам»! Нажмите кнопку, чтобы открыть магазин.",
      reply_markup: { inline_keyboard: [[{ text: "Открыть магазин", web_app: { url: env.SHOP_URL } }]] },
    });
  }
  return new Response("ok");
}

// ---------- маршрутизация ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
    try {
      if (url.pathname === "/order" && request.method === "POST") return await handleOrder(request, env);
      if (url.pathname === "/webhook" && request.method === "POST") return await handleWebhook(request, env);
    } catch (e) {
      console.log("error", e && e.stack ? e.stack : String(e));
      return json(env, { ok: false, error: "Внутренняя ошибка" }, 500);
    }
    return new Response("ok");
  },
};
