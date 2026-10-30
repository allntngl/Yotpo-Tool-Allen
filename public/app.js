// Yotpo Tool - dashboard logic.
// All API calls go through a proxy (the local server, or the Cloudflare Worker
// on the hosted version), so the browser never calls Yotpo directly and there
// are no CORS errors.

// On localhost use the local server; on a website use the Worker from config.js.
const IS_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const PROXY_URL = IS_LOCAL ? "/proxy" : (window.YOTPO_TOOL_CONFIG?.proxyUrl || "").trim();

const CORE = "https://api.yotpo.com/core/v3/stores";
const API = "https://api.yotpo.com";
const CDN = "https://api-cdn.yotpo.com";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- storage (store ID persists, token lasts for the browser session) ----------

const store = {
  get(area, key) { try { return window[area].getItem(key) || ""; } catch { return ""; } },
  set(area, key, val) { try { val ? window[area].setItem(key, val) : window[area].removeItem(key); } catch {} },
};

const storeIdEl = $("#storeId");
const tokenEl = $("#token");
storeIdEl.value = store.get("localStorage", "yt_store_id");
tokenEl.value = store.get("sessionStorage", "yt_token");
$("#authStoreId").value = storeIdEl.value;

function setTokenStatus(kind, text) {
  const el = $("#tokenStatus");
  el.className = `pill ${kind}`;
  el.textContent = text;
}
function refreshTokenStatus() {
  tokenEl.value ? setTokenStatus("ok", "Token set") : setTokenStatus("muted", "No token");
}
refreshTokenStatus();

storeIdEl.addEventListener("input", () => {
  store.set("localStorage", "yt_store_id", storeIdEl.value.trim());
  $("#authStoreId").value = storeIdEl.value.trim();
});
tokenEl.addEventListener("input", () => {
  store.set("sessionStorage", "yt_token", tokenEl.value.trim());
  refreshTokenStatus();
});
$("#toggleToken").addEventListener("click", (e) => {
  const show = tokenEl.type === "password";
  tokenEl.type = show ? "text" : "password";
  e.currentTarget.classList.toggle("on", show);
  e.currentTarget.setAttribute("aria-label", show ? "Hide token" : "Show token");
});

// ---------- helpers ----------

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Review text comes back HTML-encoded (e.g. &#x27;); decode it for display.
function decodeEntities(s) {
  if (typeof s !== "string" || !s.includes("&")) return s;
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}

function requireStoreId() {
  const id = storeIdEl.value.trim();
  if (!id) { toast("Enter your Store ID at the top first."); storeIdEl.focus(); throw new Error("no store id"); }
  return encodeURIComponent(id);
}
function requireToken() {
  const t = tokenEl.value.trim();
  if (!t) { toast("No access token. Generate one on the Auth tab."); throw new Error("no token"); }
  return t;
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// datetime-local value (local time) -> ISO 8601 UTC without milliseconds
function toIso(v) {
  if (!v) return "";
  return new Date(v).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function idList(raw) {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function parseBody(form) {
  const raw = form.elements.body.value.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    toast(`Invalid JSON: ${e.message}`, 4000);
    form.elements.body.focus();
    throw e;
  }
}

function confirmWrite(method, what) {
  return confirm(`${method} ${what}\n\nThis changes data in the live Yotpo store "${storeIdEl.value.trim()}". Continue?`);
}

async function withBusy(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add("busy"); }
  try { return await fn(); }
  catch (e) { if (!/^no (store id|token)$/.test(e.message) && !(e instanceof SyntaxError)) console.error(e); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove("busy"); } }
}

// ---------- API call through the proxy ----------
// Order of preference: the local server (on localhost), the Yotpo Tool
// Connector browser extension, then a Cloudflare Worker set in config.js.

const PROXY_HELP = IS_LOCAL
  ? "Can't reach the local server. Is `npm start` still running?"
  : "Can't reach the proxy. Check proxyUrl in config.js, and that the Worker's ALLOWED_ORIGINS includes " + location.origin + ".";
const CONNECTOR_ZIP = "yotpo-tool-connector.zip";
const hasConnector = () => !IS_LOCAL && !!document.documentElement.dataset.yotpoConnector;

// Sends a request to the extension through its content script and waits for the reply.
function viaConnector(payload) {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => done({ error: "The connector extension didn't answer. Try reloading the page." }), 60000);
    function onMessage(e) {
      if (e.source !== window || e.origin !== location.origin) return;
      if (e.data?.source === "yotpo-connector" && e.data.id === id) done(e.data.reply);
    }
    function done(reply) {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(reply || { error: "Empty reply from the connector extension" });
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "yotpo-tool-page", type: "request", id, payload }, location.origin);
  });
}

async function api(method, url, { body, auth = true } = {}) {
  const token = auth ? requireToken() : undefined;
  const fail = (status, data) => {
    showResult({ method, url, status, ok: false, data });
    throw new Error("proxy unreachable");
  };
  const payload = { method, url, token, body };
  let wrap, httpStatus = 200;
  if (hasConnector()) {
    wrap = await viaConnector(payload);
  } else {
    if (!PROXY_URL) {
      fail(0, `The Yotpo Tool Connector extension isn't installed. Download ${CONNECTOR_ZIP} from this site, then load it in chrome://extensions (see the setup banner).`);
    }
    let res;
    try {
      res = await fetch(PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      fail(0, PROXY_HELP);
    }
    httpStatus = res.status;
    try { wrap = await res.json(); }
    catch { fail(res.status, `The proxy returned an unexpected response (HTTP ${res.status}). ${PROXY_HELP}`); }
  }
  if (wrap.error) {
    const out = { method, url, status: httpStatus === 200 ? 0 : httpStatus, ok: false, data: wrap.error };
    showResult(out);
    return out;
  }
  let data = wrap.body;
  try { data = wrap.body ? JSON.parse(wrap.body) : null; } catch {}
  const out = { method, url, status: wrap.status, statusText: wrap.statusText, ok: wrap.status >= 200 && wrap.status < 300, data, ms: wrap.ms, headers: wrap.headers };
  if (auth && wrap.status === 401) setTokenStatus("err", "Token invalid/expired");
  return out;
}

// ---------- results ----------

let current = { out: null, rows: [], cols: [] };

const fmtDate = (v) => (v ? new Date(v).toLocaleString() : "");
const C = (label, get, opts = {}) => ({ label, get: typeof get === "string" ? (r) => r[get] : get, ...opts });

const COLS = {
  products: [
    C("Yotpo ID", "yotpo_id", { num: true }),
    C("External ID", "external_id"),
    C("Name", "name", { clip: true }),
    C("Status", "status"),
    C("Price", (r) => (r.price != null ? `${r.price} ${r.currency || ""}` : ""), { num: true }),
    C("SKU", "sku"),
    C("Group", "group_name"),
    C("URL", "url", { clip: true }),
    C("Updated", (r) => fmtDate(r.updated_at)),
    C("", (r) => ({ action: "editProduct", id: r.yotpo_id, label: "Edit" }), { action: true }),
  ],
  orders: [
    C("Yotpo ID", "yotpo_id", { num: true }),
    C("External ID", "external_id"),
    C("Order name", "order_name"),
    C("Order date", (r) => fmtDate(r.order_date)),
    C("Customer", (r) => [r.customer?.first_name, r.customer?.last_name].filter(Boolean).join(" ")),
    C("Email", (r) => r.customer?.email),
    C("Total", (r) => (r.total_price != null ? `${r.total_price} ${r.currency || ""}` : ""), { num: true }),
    C("Product IDs", (r) => (r.line_items || []).map((li) => `${li.external_product_id}×${li.quantity}`).join(", "), { clip: true }),
    C("Fulfillment", (r) => (r.fulfillments || []).map((f) => f.status).join(", ")),
    C("Cancelled", (r) => (r.cancellation ? fmtDate(r.cancellation.cancellation_date) : "")),
    C("", (r) => ({ action: "editOrder", id: r.yotpo_id, label: "Edit" }), { action: true }),
  ],
  reviews: [
    C("Review ID", "id", { num: true }),
    C("Score", "score", { num: true }),
    C("Title", (r) => decodeEntities(r.title), { clip: true }),
    C("Content", (r) => decodeEntities(r.content), { clip: true }),
    C("Name", "name"),
    C("Email", "email"),
    C("SKU / Product", "sku"),
    C("Created", (r) => fmtDate(r.created_at)),
    C("Deleted", (r) => (r.deleted ? "yes" : "")),
    C("Incentivized", (r) => (r.is_incentivized ? r.incentive_type || "yes" : "")),
  ],
  widgetReviews: [
    C("Review ID", "id", { num: true }),
    C("Score", "score", { num: true }),
    C("Title", (r) => decodeEntities(r.title), { clip: true }),
    C("Content", (r) => decodeEntities(r.content), { clip: true }),
    C("Reviewer", (r) => r.user?.display_name),
    C("Verified buyer", (r) => (r.verified_buyer ? "yes" : "")),
    C("Votes", (r) => `+${r.votes_up || 0} / -${r.votes_down || 0}`),
    C("Created", (r) => fmtDate(r.created_at)),
  ],
};

// Turn any object into key/value rows for single-record responses.
function kvRows(obj, prefix = "") {
  const rows = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) rows.push(...kvRows(v, key));
    else rows.push({ field: key, value: Array.isArray(v) ? JSON.stringify(v) : v });
  }
  return rows;
}
const KV_COLS = [C("Field", "field"), C("Value", "value", { clip: false })];

function showResult(out, rows = null, cols = null, summary = "", fromHistory = false) {
  if (!fromHistory) addHistory(out, rows, cols, summary);
  current = { out, rows: rows || [], cols: cols || [] };
  const box = $("#result");
  box.hidden = false;

  const st = $("#resStatus");
  st.className = `pill ${out.ok ? "ok" : out.status === 0 ? "warn" : "err"}`;
  st.textContent = out.status ? `${out.status}${out.statusText ? " " + out.statusText : ""}` : "Error";
  $("#resLine").textContent = `${out.method} ${out.url}${out.ms != null ? `  ·  ${out.ms} ms` : ""}`;

  let sum = summary;
  if (!out.ok) sum = errorHint(out);
  else if (out.headers?.["ratelimit-remaining"]) sum += `${sum ? "  ·  " : ""}Rate limit remaining: ${out.headers["ratelimit-remaining"]}`;
  $("#resSummary").textContent = sum;

  $("#resJson").textContent = typeof out.data === "string" ? out.data : JSON.stringify(out.data, null, 2) || "(empty response body)";
  renderTable();
  const hasTable = current.rows.length > 0 || (out.ok && cols);
  setView(hasTable ? "table" : "json");
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function errorHint(out) {
  const msgs = [];
  const d = out.data;
  if (d && typeof d === "object") {
    (d.errors || []).forEach((e) => msgs.push(e.message || JSON.stringify(e)));
    if (d.status?.message) msgs.push(d.status.message);
    if (d.message) msgs.push(d.message);
  } else if (typeof d === "string" && d) msgs.push(d);
  const hints = {
    401: "Token is invalid or expired. Generate a new one on the Auth tab.",
    403: "Forbidden. The token is missing or not allowed for this store.",
    404: "Not found. Check the ID, and whether you used a Yotpo ID or an external ID.",
    409: "Conflict. A record with this external ID already exists.",
  };
  if (hints[out.status]) msgs.push(hints[out.status]);
  return msgs.join("  ·  ");
}

function renderTable() {
  const wrap = $("#resTable");
  const { rows, cols } = current;
  if (!cols.length) { wrap.innerHTML = ""; return; }
  if (!rows.length) { wrap.innerHTML = `<div class="empty">No records returned.</div>`; return; }
  const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join("");
  const body = rows.map((r) => "<tr>" + cols.map((c) => {
    const v = c.get(r);
    if (c.action) return v?.id != null ? `<td><button class="ghost" data-action="${v.action}" data-id="${esc(v.id)}">${v.label}</button></td>` : "<td></td>";
    const text = esc(v);
    // ID columns copy their value on click
    if (/ID$/.test(c.label) && text) return `<td class="num"><button type="button" class="copy-id" data-copy="${text}" title="Click to copy">${text}</button></td>`;
    return `<td class="${c.num ? "num" : ""}">${c.clip ? `<span class="clip" title="${text}">${text}</span>` : text}</td>`;
  }).join("") + "</tr>").join("");
  wrap.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function setView(view) {
  $$(".segbtn[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#resTable").hidden = view !== "table";
  $("#resJson").hidden = view !== "json";
}
$$(".segbtn[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

function closeResult() {
  $("#result").hidden = true;
  current = { out: null, rows: [], cols: [] };
}
$("#closeResult").addEventListener("click", closeResult);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#result").hidden && !e.target.closest?.("input, textarea, select")) closeResult();
});

$("#copyJson").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#resJson").textContent); toast("JSON copied"); }
  catch { toast("Couldn't access the clipboard"); }
});

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
$("#downloadJson").addEventListener("click", () => download(`yotpo-${stamp()}.json`, $("#resJson").textContent, "application/json"));
$("#downloadCsv").addEventListener("click", () => {
  const cols = current.cols.filter((c) => !c.action);
  if (!current.rows.length || !cols.length) return toast("Nothing to export as CSV");
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.map((c) => cell(c.label)).join(",")];
  current.rows.forEach((r) => lines.push(cols.map((c) => cell(c.get(r))).join(",")));
  download(`yotpo-${stamp()}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
});

// ---------- tabs ----------

$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${t.dataset.tab}`));
  $("#pageTitle").textContent = t.dataset.title;
  $("#pageDesc").textContent = t.dataset.desc;
  setMenu(false);
}));

// Mobile sidebar
function setMenu(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").hidden = !open;
}
$("#menuBtn").addEventListener("click", () => setMenu(true));
$("#scrim").addEventListener("click", () => setMenu(false));

// Theme toggle: follows the system until the user picks one
function currentTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function syncThemeLabel() {
  $("#themeToggle span").textContent = currentTheme() === "dark" ? "Light mode" : "Dark mode";
}
$("#themeToggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("localStorage", "yt_theme", next);
  syncThemeLabel();
});
syncThemeLabel();

// Ctrl/Cmd + Enter submits the form you're typing in
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
  const form = e.target.closest?.("form");
  if (form) { e.preventDefault(); form.requestSubmit(); }
});

// Click an ID in a result table to copy it
$("#resTable").addEventListener("click", async (e) => {
  const b = e.target.closest(".copy-id");
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); toast(`Copied ${b.dataset.copy}`); }
  catch { toast("Couldn't access the clipboard"); }
});

// ---------- request history (this session only, kept in memory) ----------

const reqHistory = [];
function addHistory(out, rows, cols, summary) {
  reqHistory.unshift({ out, rows, cols, summary, at: new Date() });
  if (reqHistory.length > 50) reqHistory.pop();
  renderHistory();
}
function renderHistory() {
  const count = $("#historyCount");
  count.hidden = !reqHistory.length;
  count.textContent = reqHistory.length;
  $("#historyList").innerHTML = reqHistory.length
    ? reqHistory.map((h, i) => {
        const u = (() => { try { return new URL(h.out.url); } catch { return null; } })();
        const path = u ? (u.pathname + u.search).replace(/utoken=[^&]+/, "utoken=…") : h.out.url;
        const kind = h.out.ok ? "ok" : h.out.status === 0 ? "warn" : "err";
        return `<button type="button" class="history-row" data-h="${i}">
          <span class="m ${esc(h.out.method.toLowerCase())}">${esc(h.out.method)}</span>
          <span class="h-path">${esc(path)}</span>
          <span class="pill ${kind}">${esc(h.out.status || "ERR")}</span>
          <span class="h-time">${h.at.toLocaleTimeString()}</span>
        </button>`;
      }).join("")
    : `<div class="empty">No requests yet.</div>`;
}
$("#historyList").addEventListener("click", (e) => {
  const row = e.target.closest("[data-h]");
  if (!row) return;
  const h = reqHistory[Number(row.dataset.h)];
  showResult(h.out, h.rows, h.cols, h.summary, true);
});
$("#clearHistory").addEventListener("click", () => { reqHistory.length = 0; renderHistory(); });

function openSub(group, sub) {
  $$(`.subtabs[data-group="${group}"] .sub`).forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  $$(`.subpanel[data-group="${group}"]`).forEach((p) => p.classList.toggle("active", p.dataset.sub === sub));
}
$$(".subtabs").forEach((bar) => bar.addEventListener("click", (e) => {
  const b = e.target.closest(".sub");
  if (b) openSub(bar.dataset.group, b.dataset.sub);
}));

// ---------- JSON templates ----------

const TEMPLATES = {
  reviewUpdate: (mode) => mode === "incentive"
    ? { reviews: [{ review_id: 123456, is_incentivized: true, incentive_type: "free_product" }] }
    : {
        customer: { state: "California", country: "US" },
        product: { color: "black", size: "large" },
        order: { coupon_used: true, delivery_type: "standard" },
      },
};

const TEMPLATE_FORMS = {
  reviewUpdate: "#reviewsUpdate",
};
function loadTemplate(name) {
  const form = $(TEMPLATE_FORMS[name]);
  const mode = form.elements.mode?.value;
  form.elements.body.value = JSON.stringify(TEMPLATES[name](mode), null, 2);
}
Object.keys(TEMPLATE_FORMS).forEach(loadTemplate);
$$("[data-template]").forEach((b) => b.addEventListener("click", () => loadTemplate(b.dataset.template)));

// ---------- Auth ----------

$("#authForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const btn = e.submitter;
  withBusy(btn, async () => {
    const sid = $("#authStoreId").value.trim();
    const secret = $("#authSecret").value.trim();
    const url = `${CORE}/${encodeURIComponent(sid)}/access_tokens`;
    const out = await api("POST", url, { body: { secret }, auth: false });
    const shown = { ...out, data: out.ok && out.data?.access_token ? { access_token: out.data.access_token.slice(0, 6) + "…(hidden, saved to the token field)" } : out.data };
    showResult(shown, null, null, out.ok ? "Token generated and saved for this browser session." : "");
    if (out.ok && out.data?.access_token) {
      storeIdEl.value = sid;
      store.set("localStorage", "yt_store_id", sid);
      tokenEl.value = out.data.access_token;
      store.set("sessionStorage", "yt_token", out.data.access_token);
      setTokenStatus("ok", "Token ready");
      $("#authSecret").value = "";
      toast("Access token generated");
    }
  });
});

$("#testToken").addEventListener("click", (e) => withBusy(e.target, async () => {
  const sid = requireStoreId();
  const out = await api("GET", `${CORE}/${sid}/products${qs({ limit: 1 })}`);
  showResult(out, out.data?.products || [], COLS.products, out.ok ? "Token works." : "");
  if (out.ok) setTokenStatus("ok", "Token valid");
}));

$("#copyToken").addEventListener("click", async () => {
  if (!tokenEl.value) return toast("No token to copy");
  try { await navigator.clipboard.writeText(tokenEl.value); toast("Token copied"); }
  catch { toast("Couldn't access the clipboard"); }
});
$("#clearToken").addEventListener("click", () => {
  tokenEl.value = "";
  store.set("sessionStorage", "yt_token", "");
  refreshTokenStatus();
  toast("Token cleared");
});

// ---------- pagination ("Next page" buttons) ----------

const nextPage = {};
function setNext(formId, value) {
  nextPage[formId] = value || "";
  const btn = $(`[data-next="${formId}"]`);
  if (btn) btn.disabled = !value;
}
$$("[data-next]").forEach((btn) => btn.addEventListener("click", () => {
  const form = $(`#${btn.dataset.next}`);
  if (form.elements.page_info) form.elements.page_info.value = nextPage[btn.dataset.next];
  if (form.elements.page) form.elements.page.value = nextPage[btn.dataset.next];
  form.requestSubmit();
}));

function onSubmit(id, handler) {
  $(id).addEventListener("submit", (e) => {
    e.preventDefault();
    withBusy(e.submitter, () => handler(e.target, e.submitter));
  });
}

// ---------- sectioned create forms (shared by product, order and review) ----------
// Each create form has a Form mode, where fields build the payload, and a JSON
// mode for the raw payload. Switching modes converts one into the other.

const isUrl = (v) => /^https?:\/\/\S+$/i.test(v);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const val = (el) => String(el?.value ?? "").trim();
const num = (el) => (val(el) === "" ? undefined : Number(val(el)));
const upper = (el) => val(el).toUpperCase();
const setVal = (el, v) => { if (el && v !== undefined && v !== null) el.value = v; };

// ISO date <-> datetime-local input value (local time)
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const nowLocalInput = () => isoToLocalInput(new Date().toISOString());

// Removes keys that are undefined, "" or empty objects (recursively).
function compact(obj) {
  for (const [k, v] of Object.entries(obj)) {
    const isObj = v && typeof v === "object" && !Array.isArray(v);
    if (isObj) compact(v);
    if (v === undefined || v === "" || (isObj && !Object.keys(v).length)) delete obj[k];
  }
  return obj;
}

function clearErrors(root) {
  $$(".invalid", root).forEach((f) => f.classList.remove("invalid"));
  $$(".field-error", root).forEach((e) => e.remove());
}
function markInvalid(el, msg) {
  const field = el.closest(".field") || el.closest(".check");
  if (!field || field.querySelector(".field-error")) return;
  field.classList.add("invalid");
  const err = document.createElement("span");
  err.className = "field-error";
  err.textContent = msg;
  field.appendChild(err);
  const details = el.closest("details");
  if (details) details.open = true;
}

// Collects validation failures; done() focuses the first one and reports validity.
function validator(form) {
  clearErrors(form);
  const bad = [];
  const fail = (el, msg) => { markInvalid(el, msg); bad.push(el); return false; };
  return {
    fail,
    need: (el, msg = "Required") => (val(el) ? true : fail(el, msg)),
    // Checks a rule only when the field has a value
    rule: (el, ok, msg) => (!val(el) || ok(val(el)) ? true : fail(el, msg)),
    done() {
      if (bad.length) { bad[0].focus(); toast("Please fix the highlighted fields"); }
      return !bad.length;
    },
  };
}

function setupCreateForm(form, { build, populate, validate, sync = () => {}, reset = () => {} }) {
  let mode = "form";
  function setMode(next) {
    if (next === mode) return;
    if (next === "json") {
      form.elements.body.value = JSON.stringify(build(), null, 2);
    } else {
      try { populate(JSON.parse(form.elements.body.value)); clearErrors(form); sync(); }
      catch { toast("JSON is invalid, so the form wasn't updated"); }
    }
    mode = next;
    $$("[data-mode]", form).forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    $$("[data-mode-panel]", form).forEach((p) => (p.hidden = p.dataset.modePanel !== mode));
  }
  $$("[data-mode]", form).forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("[data-preview-json]", form)?.addEventListener("click", () => setMode("json"));
  $("[data-reset]", form)?.addEventListener("click", () => { form.reset(); clearErrors(form); reset(); sync(); });
  form.addEventListener("input", (e) => {
    // Clear a field's error as soon as it's edited
    const field = e.target.closest(".invalid");
    if (field) { field.classList.remove("invalid"); field.querySelector(".field-error")?.remove(); }
    sync();
  });
  form.addEventListener("change", sync);
  reset();
  sync();
  return {
    // The payload to send, or null when the form is invalid.
    body: () => (mode === "json" ? parseBody(form) : validate() ? build() : null),
    // Re-render after the form was changed from code
    refresh() {
      if (mode === "json") form.elements.body.value = JSON.stringify(build(), null, 2);
      sync();
    },
  };
}

// ---------- update forms ----------
// "Load current values" fetches the record and fills the form; after that only
// fields that differ from what was loaded are sent. Empty fields mean "no change".

const tri = (el) => (el.value === "" ? undefined : el.value === "true");
const setTri = (el, v) => { if (v !== undefined && v !== null) el.value = String(!!v); };

// The parts of `next` that differ from `prev`, recursing into plain objects.
function diff(next, prev) {
  const out = {};
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  for (const [k, v] of Object.entries(next)) {
    if (isObj(v) && isObj(prev?.[k])) {
      const d = diff(v, prev[k]);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(v) !== JSON.stringify(prev?.[k])) {
      out[k] = v;
    }
  }
  return out;
}
const countLeaves = (o) => Object.values(o).reduce((n, v) =>
  n + (v && typeof v === "object" && !Array.isArray(v) ? countLeaves(v) : 1), 0);

// kind: "product" | "order". readAll() returns every filled field; fill(record, merge) writes a record into the form.
function setupUpdateForm(form, { kind, readAll, fill, validate, sync = () => {}, reset = () => {} }) {
  const state = { snapshot: null, loadedId: "", record: null };
  const statusEl = $("[data-load-status]", form);
  const countEl = $("[data-change-count]", form);
  const setStatus = (text, cls = "") => { statusEl.textContent = text; statusEl.className = `load-status ${cls}`; };
  const changes = () => (state.snapshot ? diff(readAll(state), state.snapshot) : readAll(state));

  const ctl = setupCreateForm(form, {
    build: () => ({ [kind]: changes() }),
    // JSON -> Form: start again from the loaded record, then apply the JSON on top,
    // so a field deleted from the JSON goes back to its loaded value.
    populate(b) {
      const id = form.elements.id.value;
      form.reset();
      form.elements.id.value = id;
      reset(state);
      if (state.record) fill(state.record, false);
      fill(b[kind] || {}, true);
    },
    validate,
    sync() {
      sync(state);
      const n = countLeaves(changes());
      countEl.textContent = n ? `${n} field${n === 1 ? "" : "s"} will be updated` : "No changes yet";
      countEl.classList.toggle("has", n > 0);
      if (state.snapshot && val(form.elements.id) !== state.loadedId) {
        setStatus(`The ID changed since you loaded ${kind} ${state.loadedId}. Load again before updating.`, "warn");
      }
    },
    reset() {
      state.snapshot = null;
      state.record = null;
      state.loadedId = "";
      reset(state);
      setStatus(`Not loaded. Load the ${kind} to edit its current values, or fill only the fields to change.`);
    },
  });

  async function load() {
    const id = val(form.elements.id);
    if (!id) { form.elements.id.focus(); return toast(`Enter the Yotpo ${kind} ID first`); }
    const sid = requireStoreId();
    setStatus(`Loading ${kind} ${id}…`);
    const out = await api("GET", `${CORE}/${sid}/${kind}s/${encodeURIComponent(id)}`);
    const rec = out.data?.[kind];
    if (!out.ok || !rec) {
      showResult(out);
      setStatus(`Couldn't load ${kind} ${id}. See the response below.`, "err");
      return;
    }
    form.reset();
    form.elements.id.value = id;
    clearErrors(form);
    reset(state);
    state.record = rec;
    fill(rec, false);
    state.snapshot = readAll(state);
    state.loadedId = id;
    const label = rec.name || rec.order_name || rec.external_id || "";
    setStatus(`Loaded ${kind} ${id}${label ? ` (${label})` : ""} at ${new Date().toLocaleTimeString()}. Edit any field below.`, "ok");
    ctl.refresh();
  }
  $("[data-load]", form).addEventListener("click", (e) => withBusy(e.currentTarget, load));

  return {
    state,
    body: ctl.body,
    load,
    // After a successful update the form's values are the new baseline.
    saved() { if (state.snapshot) state.snapshot = readAll(state); ctl.refresh(); },
  };
}

// Shared submit flow for the update forms.
async function submitUpdate(form, ctl, kind) {
  const sid = requireStoreId();
  const id = val(form.elements.id);
  if (!id) { clearErrors(form); markInvalid(form.elements.id, "Required"); form.elements.id.focus(); return; }
  if (ctl.state.snapshot && id !== ctl.state.loadedId) return toast(`The ${kind} ID changed. Load it again before updating.`, 3500);
  const body = ctl.body();
  if (!body) return;
  const fields = Object.keys(body[kind] || {});
  if (!fields.length) return toast("Nothing to update. Change a field first.");
  if (!confirmWrite(`Update ${kind}`, `${id}\nFields: ${fields.join(", ")}`)) return;
  const out = await api("PATCH", `${CORE}/${sid}/${kind}s/${encodeURIComponent(id)}`, { body });
  showResult(out, null, null, out.ok ? `${kind[0].toUpperCase() + kind.slice(1)} ${id} updated: ${fields.join(", ")}.` : "");
  if (out.ok) { toast(`${kind[0].toUpperCase() + kind.slice(1)} updated`); ctl.saved(); }
}

// ---------- Products ----------

onSubmit("#productsList", async (f) => {
  const sid = requireStoreId();
  const url = `${CORE}/${sid}/products${qs({ limit: f.elements.limit.value, page_info: f.elements.page_info.value.trim() })}`;
  const out = await api("GET", url);
  const rows = out.data?.products || [];
  const next = out.data?.pagination?.next_page_info;
  setNext("productsList", out.ok ? next : "");
  f.elements.page_info.value = "";
  showResult(out, rows, COLS.products, out.ok ? `${rows.length} products${next ? ". More available, use Next page." : ". Last page."}` : "");
});

onSubmit("#productsById", async (f) => {
  const sid = requireStoreId();
  const ids = idList(f.elements.ids.value);
  if (f.elements.idType.value === "yotpo") {
    const out = await api("GET", `${CORE}/${sid}/products/${encodeURIComponent(ids[0])}`);
    showResult(out, out.data?.product ? [out.data.product] : [], COLS.products);
  } else {
    const out = await api("GET", `${CORE}/${sid}/products${qs({ external_ids: ids.join(",") })}`);
    const rows = out.data?.products || [];
    showResult(out, rows, COLS.products, out.ok ? `${rows.length} of ${ids.length} product(s) found` : "");
  }
});

// Create product
const pcForm = $("#productsCreate");
const pc = (n) => pcForm.elements[`pc_${n}`];

const pcCreate = setupCreateForm(pcForm, {
  build() {
    const gtin = val(pc("gtin_value"));
    return {
      product: {
        external_id: val(pc("external_id")),
        name: val(pc("name")),
        ...compact({
          status: val(pc("status")),
          description: val(pc("description")),
          url: val(pc("url")),
          image_url: val(pc("image_url")),
          price: num(pc("price")),
          compare_at_price: num(pc("compare_at_price")),
          currency: upper(pc("currency")),
          inventory_quantity: num(pc("inventory_quantity")),
          is_discontinued: pc("is_discontinued").checked || undefined,
          group_name: val(pc("group_name")),
          brand: val(pc("brand")),
          sku: val(pc("sku")),
          mpn: val(pc("mpn")),
          handle: val(pc("handle")),
          gtins: gtin ? [{ declared_type: val(pc("gtin_type")), value: gtin }] : undefined,
          custom_properties: {
            is_blocklisted: pc("is_blocklisted").checked || undefined,
            review_form_tag: val(pc("review_form_tag")),
          },
        }),
      },
    };
  },
  populate(b) {
    const p = b.product || {};
    pcForm.reset();
    for (const k of ["external_id", "name", "status", "description", "url", "image_url", "price", "compare_at_price",
      "currency", "inventory_quantity", "group_name", "brand", "sku", "mpn", "handle"]) setVal(pc(k), p[k]);
    pc("is_discontinued").checked = !!p.is_discontinued;
    setVal(pc("gtin_type"), p.gtins?.[0]?.declared_type);
    setVal(pc("gtin_value"), p.gtins?.[0]?.value);
    pc("is_blocklisted").checked = !!p.custom_properties?.is_blocklisted;
    setVal(pc("review_form_tag"), p.custom_properties?.review_form_tag);
  },
  validate() {
    const v = validator(pcForm);
    v.need(pc("external_id"));
    v.need(pc("name"));
    v.rule(pc("sku"), (s) => !/[\s/]/.test(s), "No spaces or / allowed");
    v.rule(pc("url"), isUrl, "Must start with http:// or https://");
    v.rule(pc("image_url"), isUrl, "Must start with http:// or https://");
    v.rule(pc("price"), (s) => Number(s) >= 0, "Must be 0 or more");
    v.rule(pc("compare_at_price"), (s) => Number(s) >= 0, "Must be 0 or more");
    v.rule(pc("currency"), (s) => /^[A-Za-z]{3}$/.test(s), "Use a 3-letter code, e.g. USD");
    v.rule(pc("inventory_quantity"), (s) => Number.isInteger(Number(s)), "Must be a whole number");
    v.rule(pc("group_name"), (s) => /^[A-Za-z0-9_-]+$/.test(s), "Only letters, numbers, _ and -");
    return v.done();
  },
});

onSubmit("#productsCreate", async () => {
  const sid = requireStoreId();
  const body = pcCreate.body();
  if (!body) return;
  const p = body.product || {};
  if (!confirmWrite("Create product", `"${p.name || ""}" with external ID ${p.external_id || ""}`)) return;
  const out = await api("POST", `${CORE}/${sid}/products`, { body });
  showResult(out, null, null, out.ok ? `Created. Yotpo product ID: ${out.data?.product?.yotpo_id}` : "");
  if (out.ok) toast("Product created");
});

// Update product
const puForm = $("#productsUpdate");
const pu = (n) => puForm.elements[`pu_${n}`];

const puUpdate = setupUpdateForm(puForm, {
  kind: "product",
  readAll() {
    const gtin = val(pu("gtin_value"));
    return compact({
      name: val(pu("name")),
      status: val(pu("status")),
      description: val(pu("description")),
      url: val(pu("url")),
      image_url: val(pu("image_url")),
      price: num(pu("price")),
      compare_at_price: num(pu("compare_at_price")),
      currency: upper(pu("currency")),
      inventory_quantity: num(pu("inventory_quantity")),
      is_discontinued: tri(pu("is_discontinued")),
      group_name: val(pu("group_name")),
      brand: val(pu("brand")),
      sku: val(pu("sku")),
      mpn: val(pu("mpn")),
      handle: val(pu("handle")),
      gtins: gtin ? [{ declared_type: val(pu("gtin_type")), value: gtin }] : undefined,
      custom_properties: {
        is_blocklisted: tri(pu("is_blocklisted")),
        review_form_tag: val(pu("review_form_tag")),
      },
    });
  },
  fill(p) {
    for (const k of ["name", "status", "description", "url", "image_url", "price", "compare_at_price", "currency",
      "inventory_quantity", "group_name", "brand", "sku", "mpn", "handle"]) setVal(pu(k), p[k]);
    setTri(pu("is_discontinued"), p.is_discontinued);
    setVal(pu("gtin_type"), p.gtins?.[0]?.declared_type);
    setVal(pu("gtin_value"), p.gtins?.[0]?.value);
    setTri(pu("is_blocklisted"), p.custom_properties?.is_blocklisted);
    setVal(pu("review_form_tag"), p.custom_properties?.review_form_tag);
  },
  validate() {
    const v = validator(puForm);
    v.rule(pu("sku"), (s) => !/[\s/]/.test(s), "No spaces or / allowed");
    v.rule(pu("url"), isUrl, "Must start with http:// or https://");
    v.rule(pu("image_url"), isUrl, "Must start with http:// or https://");
    v.rule(pu("price"), (s) => Number(s) >= 0, "Must be 0 or more");
    v.rule(pu("compare_at_price"), (s) => Number(s) >= 0, "Must be 0 or more");
    v.rule(pu("currency"), (s) => /^[A-Za-z]{3}$/.test(s), "Use a 3-letter code, e.g. USD");
    v.rule(pu("inventory_quantity"), (s) => Number.isInteger(Number(s)), "Must be a whole number");
    v.rule(pu("group_name"), (s) => /^[A-Za-z0-9_-]+$/.test(s), "Only letters, numbers, _ and -");
    return v.done();
  },
});

onSubmit("#productsUpdate", () => submitUpdate(puForm, puUpdate, "product"));

// ---------- Orders ----------

onSubmit("#ordersList", async (f) => {
  const sid = requireStoreId();
  const url = `${CORE}/${sid}/orders${qs({
    limit: f.elements.limit.value,
    order_date_min: toIso(f.elements.order_date_min.value),
    order_date_max: toIso(f.elements.order_date_max.value),
    page_info: f.elements.page_info.value.trim(),
  })}`;
  const out = await api("GET", url);
  const rows = out.data?.orders || [];
  const next = out.data?.pagination?.next_page_info;
  setNext("ordersList", out.ok ? next : "");
  f.elements.page_info.value = "";
  showResult(out, rows, COLS.orders, out.ok ? `${rows.length} orders${next ? ". More available, use Next page." : ". Last page."}` : "");
});

onSubmit("#ordersById", async (f) => {
  const sid = requireStoreId();
  const ids = idList(f.elements.ids.value);
  if (f.elements.idType.value === "yotpo") {
    const out = await api("GET", `${CORE}/${sid}/orders/${encodeURIComponent(ids[0])}`);
    showResult(out, out.data?.order ? [out.data.order] : [], COLS.orders);
  } else {
    const out = await api("GET", `${CORE}/${sid}/orders${qs({ external_ids: ids.join(",") })}`);
    const rows = out.data?.orders || [];
    showResult(out, rows, COLS.orders, out.ok ? `${rows.length} of ${ids.length} order(s) found` : "");
  }
});

let stopScan = false;
$("#stopScan").addEventListener("click", () => { stopScan = true; });

onSubmit("#ordersByProduct", async (f, btn) => {
  const sid = requireStoreId();
  requireToken();
  const pid = f.elements.productId.value.trim();
  const maxPages = Math.max(1, Math.min(100, Number(f.elements.maxPages.value) || 10));
  const dateMin = toIso(f.elements.order_date_min.value);
  const dateMax = toIso(f.elements.order_date_max.value);
  const matches = [];
  let pageInfo = "", pages = 0, scanned = 0, last;
  stopScan = false;
  $("#stopScan").disabled = false;
  try {
    do {
      const url = `${CORE}/${sid}/orders${qs({ limit: 100, order_date_min: dateMin, order_date_max: dateMax, page_info: pageInfo })}`;
      last = await api("GET", url);
      if (!last.ok) break;
      const orders = last.data?.orders || [];
      scanned += orders.length;
      pages++;
      matches.push(...orders.filter((o) => (o.line_items || []).some((li) => String(li.external_product_id) === pid)));
      pageInfo = last.data?.pagination?.next_page_info || "";
      toast(`Scanned ${scanned} orders, ${matches.length} match…`, 1500);
    } while (pageInfo && pages < maxPages && !stopScan);
  } finally {
    $("#stopScan").disabled = true;
  }
  if (!last?.ok) return showResult(last);
  const more = pageInfo ? " More orders remain unscanned; raise the page limit or narrow the dates." : "";
  showResult({ ...last, data: { orders: matches } }, matches, COLS.orders,
    `${matches.length} order(s) contain product "${pid}". Scanned ${scanned} orders across ${pages} page(s).${stopScan ? " Stopped early." : ""}${more}`);
});

// Create order
const ocForm = $("#ordersCreate");
const oc = (n) => ocForm.elements[`oc_${n}`];
const ocItems = $("#ocLineItems");
const liField = (row, f) => $(`[data-f="${f}"]`, row);
const lineItemRows = (box = ocItems) => $$(".li-row", box);
const LI_FIELDS = ["external_product_id", "quantity", "total_price", "external_variant_id", "coupon_code"];

function addLineItem(data = {}, box = ocItems) {
  const row = $("#lineItemTpl").content.firstElementChild.cloneNode(true);
  for (const f of LI_FIELDS) setVal(liField(row, f), data[f]);
  box.appendChild(row);
  return row;
}
function isEmptyRow(row) {
  return ["external_product_id", "total_price", "external_variant_id", "coupon_code"].every((f) => !val(liField(row, f)));
}
function readLineItems(box = ocItems) {
  return lineItemRows(box)
    .filter((row) => val(liField(row, "external_product_id")))
    .map((row) => compact({
      external_product_id: val(liField(row, "external_product_id")),
      quantity: num(liField(row, "quantity")),
      total_price: num(liField(row, "total_price")),
      external_variant_id: val(liField(row, "external_variant_id")),
      coupon_code: val(liField(row, "coupon_code")),
    }));
}

function syncOrderForm() {
  $("[data-fulfill-fields]", ocForm).hidden = !oc("fulfill").checked;
  const totals = lineItemRows().map((r) => num(liField(r, "total_price"))).filter((n) => n !== undefined && !isNaN(n));
  $("#ocTotalHint").textContent = totals.length ? `line items sum to ${totals.reduce((a, b) => a + b, 0).toFixed(2)}` : "optional";
}

const ocCreate = setupCreateForm(ocForm, {
  build() {
    const items = readLineItems();
    const ext = val(oc("external_id"));
    const fulfillment = oc("fulfill").checked
      ? compact({
          external_id: val(oc("fulfillment_id")) || (ext ? `${ext}-F1` : ""),
          fulfillment_date: toIso(oc("fulfillment_date").value),
          status: val(oc("fulfillment_status")),
          shipment_info: { shipment_status: val(oc("shipment_status")) },
          fulfilled_items: items.map((li) => ({ external_product_id: li.external_product_id, quantity: li.quantity })),
        })
      : null;
    return {
      order: {
        external_id: ext,
        order_date: toIso(oc("order_date").value),
        customer: compact({
          external_id: val(oc("customer_id")),
          email: val(oc("email")),
          first_name: val(oc("first_name")),
          last_name: val(oc("last_name")),
          phone_number: val(oc("phone")),
        }),
        line_items: items,
        ...compact({
          order_name: val(oc("order_name")),
          currency: upper(oc("currency")),
          total_price: num(oc("total_price")),
          subtotal_price: num(oc("subtotal_price")),
          payment_status: val(oc("payment_status")),
          payment_method: val(oc("payment_method")),
          landing_site_url: val(oc("landing_site_url")),
          fulfillments: fulfillment ? [fulfillment] : undefined,
          shipping_address: {
            address1: val(oc("address1")),
            address2: val(oc("address2")),
            city: val(oc("city")),
            state: val(oc("state")),
            zip: val(oc("zip")),
            country_code: upper(oc("country_code")),
          },
          custom_properties: {
            coupon_used: oc("coupon_used").checked || undefined,
            suppress_review_request: oc("suppress_review_request").checked || undefined,
          },
        }),
      },
    };
  },
  populate(b) {
    const o = b.order || {};
    ocForm.reset();
    for (const k of ["external_id", "order_name", "currency", "total_price", "subtotal_price", "payment_status",
      "payment_method", "landing_site_url"]) setVal(oc(k), o[k]);
    oc("order_date").value = isoToLocalInput(o.order_date);
    const c = o.customer || {};
    setVal(oc("customer_id"), c.external_id);
    setVal(oc("email"), c.email);
    setVal(oc("first_name"), c.first_name);
    setVal(oc("last_name"), c.last_name);
    setVal(oc("phone"), c.phone_number);
    ocItems.innerHTML = "";
    (o.line_items?.length ? o.line_items : [{}]).forEach((li) => addLineItem(li));
    const f = o.fulfillments?.[0];
    oc("fulfill").checked = !!f;
    if (f) {
      setVal(oc("fulfillment_id"), f.external_id);
      oc("fulfillment_date").value = isoToLocalInput(f.fulfillment_date);
      setVal(oc("fulfillment_status"), f.status);
      setVal(oc("shipment_status"), f.shipment_info?.shipment_status);
    }
    const a = o.shipping_address || {};
    for (const k of ["address1", "address2", "city", "state", "zip", "country_code"]) setVal(oc(k), a[k]);
    oc("coupon_used").checked = !!o.custom_properties?.coupon_used;
    oc("suppress_review_request").checked = !!o.custom_properties?.suppress_review_request;
  },
  validate() {
    const v = validator(ocForm);
    v.need(oc("external_id"));
    v.need(oc("order_date"));
    v.rule(oc("currency"), (s) => /^[A-Za-z]{3}$/.test(s), "Use a 3-letter code, e.g. USD");
    v.need(oc("first_name"));
    v.need(oc("last_name"));
    if (v.need(oc("email"))) v.rule(oc("email"), isEmail, "Enter a valid email");
    v.rule(oc("phone"), (s) => /^\+[1-9]\d{6,14}$/.test(s), "Use E.164 format, e.g. +14155550100");
    const rows = lineItemRows();
    rows.forEach((row) => {
      if (rows.length > 1 && isEmptyRow(row)) return; // ignore blank extra rows
      v.need(liField(row, "external_product_id"));
      const q = Number(val(liField(row, "quantity")));
      if (!(Number.isInteger(q) && q >= 1)) v.fail(liField(row, "quantity"), "1 or more");
    });
    if (oc("fulfill").checked) v.need(oc("fulfillment_date"));
    v.rule(oc("country_code"), (s) => /^[A-Za-z]{2}$/.test(s), "Use a 2-letter code, e.g. US");
    v.rule(oc("landing_site_url"), isUrl, "Must start with http:// or https://");
    return v.done();
  },
  sync: syncOrderForm,
  reset() {
    ocItems.innerHTML = "";
    addLineItem();
    oc("order_date").value = nowLocalInput();
    oc("fulfillment_date").value = nowLocalInput();
  },
});

$("#ocAddItem").addEventListener("click", () => {
  liField(addLineItem(), "external_product_id").focus();
});
ocItems.addEventListener("click", (e) => {
  const btn = e.target.closest(".li-remove");
  if (!btn) return;
  const row = btn.closest(".li-row");
  if (lineItemRows().length > 1) row.remove();
  else { LI_FIELDS.forEach((f) => (liField(row, f).value = f === "quantity" ? "1" : "")); clearErrors(row); }
  syncOrderForm();
});
$("#ocGenerateId").addEventListener("click", () => {
  oc("external_id").value = `TEST-${Date.now()}`;
  oc("external_id").dispatchEvent(new Event("input", { bubbles: true }));
});

// Line items fail if a product isn't in the Yotpo catalog, so let agents check first.
const checkProductsExist = (box) => async () => {
  const rows = lineItemRows(box).filter((r) => val(liField(r, "external_product_id")));
  if (!rows.length) return toast("Add a product ID first");
  const sid = requireStoreId();
  const ids = [...new Set(rows.map((r) => val(liField(r, "external_product_id"))))];
  const out = await api("GET", `${CORE}/${sid}/products${qs({ external_ids: ids.join(",") })}`);
  if (!out.ok) return showResult(out);
  const found = new Set((out.data?.products || []).map((p) => String(p.external_id)));
  let missing = 0;
  rows.forEach((r) => {
    const input = liField(r, "external_product_id");
    clearErrors(input.closest(".field"));
    if (!found.has(val(input))) { markInvalid(input, "Not in the Yotpo catalog"); missing++; }
  });
  toast(missing ? `${missing} product(s) not found. Create them first.` : `All ${ids.length} product(s) exist in the catalog`, 3500);
};
$("#ocCheckProducts").addEventListener("click", (e) => withBusy(e.currentTarget, checkProductsExist(ocItems)));

onSubmit("#ordersCreate", async () => {
  const sid = requireStoreId();
  const body = ocCreate.body();
  if (!body) return;
  const o = body.order || {};
  if (!confirmWrite("Create order", `${o.external_id || ""} for ${o.customer?.email || "?"} with ${o.line_items?.length || 0} line item(s)`)) return;
  const out = await api("POST", `${CORE}/${sid}/orders`, { body });
  showResult(out, null, null, out.ok ? `Created. Yotpo order ID: ${out.data?.order?.yotpo_id}` : "");
  if (out.ok) toast("Order created");
});

// Update order
const ouForm = $("#ordersUpdate");
const ou = (n) => ouForm.elements[`ou_${n}`];
const ouItems = $("#ouLineItems");

// Fulfillments from a loaded order, in request shape, so adding one keeps the others.
function toFulfillmentRequest(f) {
  return compact({
    external_id: f.external_id,
    fulfillment_date: f.fulfillment_date,
    status: f.status,
    shipment_info: f.shipment_info ? compact({ ...f.shipment_info }) : undefined,
    fulfilled_items: (f.fulfilled_items || []).map((i) => ({ external_product_id: i.external_product_id, quantity: i.quantity })),
  });
}

const ouUpdate = setupUpdateForm(ouForm, {
  kind: "order",
  readAll(state) {
    const items = readLineItems(ouItems);
    const existing = (state.record?.fulfillments || []).map(toFulfillmentRequest);
    const newFulfillment = ou("fulfill").checked
      ? compact({
          external_id: val(ou("fulfillment_id")) ||
            `${state.record?.external_id || val(ouForm.elements.id)}-F${existing.length + 1}`,
          fulfillment_date: toIso(ou("fulfillment_date").value),
          status: val(ou("fulfillment_status")),
          shipment_info: { shipment_status: val(ou("shipment_status")) },
          fulfilled_items: items.map((li) => ({ external_product_id: li.external_product_id, quantity: li.quantity })),
        })
      : null;
    return compact({
      order_name: val(ou("order_name")),
      order_date: toIso(ou("order_date").value),
      payment_status: val(ou("payment_status")),
      currency: upper(ou("currency")),
      total_price: num(ou("total_price")),
      subtotal_price: num(ou("subtotal_price")),
      payment_method: val(ou("payment_method")),
      landing_site_url: val(ou("landing_site_url")),
      cancellation: { cancellation_date: toIso(ou("cancellation_date").value) },
      customer: {
        external_id: val(ou("customer_id")),
        email: val(ou("email")),
        first_name: val(ou("first_name")),
        last_name: val(ou("last_name")),
        phone_number: val(ou("phone")),
      },
      line_items: items.length ? items : undefined,
      fulfillments: newFulfillment ? [...existing, newFulfillment] : undefined,
      shipping_address: {
        address1: val(ou("address1")),
        address2: val(ou("address2")),
        city: val(ou("city")),
        state: val(ou("state")),
        zip: val(ou("zip")),
        country_code: upper(ou("country_code")),
      },
      custom_properties: {
        coupon_used: tri(ou("coupon_used")),
        suppress_review_request: tri(ou("suppress_review_request")),
      },
    });
  },
  fill(o, merge) {
    for (const k of ["order_name", "payment_status", "currency", "total_price", "subtotal_price", "payment_method",
      "landing_site_url"]) setVal(ou(k), o[k]);
    if (o.order_date) ou("order_date").value = isoToLocalInput(o.order_date);
    if (o.cancellation?.cancellation_date) ou("cancellation_date").value = isoToLocalInput(o.cancellation.cancellation_date);
    const c = o.customer || {};
    setVal(ou("customer_id"), c.external_id);
    setVal(ou("email"), c.email);
    setVal(ou("first_name"), c.first_name);
    setVal(ou("last_name"), c.last_name);
    setVal(ou("phone"), c.phone_number);
    if (o.line_items) {
      ouItems.innerHTML = "";
      o.line_items.forEach((li) => addLineItem(li, ouItems));
    }
    // From the JSON editor, treat the last fulfillment as the one being added.
    const f = merge ? o.fulfillments?.[o.fulfillments.length - 1] : null;
    if (f) {
      ou("fulfill").checked = true;
      setVal(ou("fulfillment_id"), f.external_id);
      if (f.fulfillment_date) ou("fulfillment_date").value = isoToLocalInput(f.fulfillment_date);
      setVal(ou("fulfillment_status"), f.status);
      setVal(ou("shipment_status"), f.shipment_info?.shipment_status);
    }
    const a = o.shipping_address || {};
    for (const k of ["address1", "address2", "city", "state", "zip", "country_code"]) setVal(ou(k), a[k]);
    setTri(ou("coupon_used"), o.custom_properties?.coupon_used);
    setTri(ou("suppress_review_request"), o.custom_properties?.suppress_review_request);
  },
  validate() {
    const v = validator(ouForm);
    v.rule(ou("currency"), (s) => /^[A-Za-z]{3}$/.test(s), "Use a 3-letter code, e.g. USD");
    v.rule(ou("email"), isEmail, "Enter a valid email");
    v.rule(ou("phone"), (s) => /^\+[1-9]\d{6,14}$/.test(s), "Use E.164 format, e.g. +14155550100");
    lineItemRows(ouItems).forEach((row) => {
      if (isEmptyRow(row)) return;
      v.need(liField(row, "external_product_id"));
      const q = Number(val(liField(row, "quantity")));
      if (!(Number.isInteger(q) && q >= 1)) v.fail(liField(row, "quantity"), "1 or more");
    });
    if (ou("fulfill").checked) {
      v.need(ou("fulfillment_date"));
      if (!readLineItems(ouItems).length) v.fail(ou("fulfill"), "Load the order or add line items to fulfill");
    }
    v.rule(ou("country_code"), (s) => /^[A-Za-z]{2}$/.test(s), "Use a 2-letter code, e.g. US");
    v.rule(ou("landing_site_url"), isUrl, "Must start with http:// or https://");
    return v.done();
  },
  sync() {
    $$("[data-fulfill-fields]", ouForm).forEach((el) => (el.hidden = !ou("fulfill").checked));
    $("[data-li-empty]", ouForm).hidden = lineItemRows(ouItems).length > 0;
  },
  reset() {
    ouItems.innerHTML = "";
    ou("fulfillment_date").value = nowLocalInput();
  },
});

$("#ouAddItem").addEventListener("click", () => {
  liField(addLineItem({}, ouItems), "external_product_id").focus();
  ouForm.dispatchEvent(new Event("change"));
});
ouItems.addEventListener("click", (e) => {
  const btn = e.target.closest(".li-remove");
  if (!btn) return;
  btn.closest(".li-row").remove();
  ouForm.dispatchEvent(new Event("change"));
});
$("#ouCheckProducts").addEventListener("click", (e) => withBusy(e.currentTarget, checkProductsExist(ouItems)));

onSubmit("#ordersUpdate", () => submitUpdate(ouForm, ouUpdate, "order"));

// ---------- "Find" (external ID -> Yotpo ID) on update forms ----------

$$("[data-lookup]").forEach((btn) => btn.addEventListener("click", () => withBusy(btn, async () => {
  const kind = btn.dataset.lookup; // products | orders
  const form = btn.closest("form");
  const ext = form.elements.lookup.value.trim();
  if (!ext) return toast("Enter an external ID to look up");
  const sid = requireStoreId();
  const out = await api("GET", `${CORE}/${sid}/${kind}${qs({ external_ids: ext })}`);
  const rec = out.data?.[kind]?.[0];
  showResult(out, out.data?.[kind] || [], COLS[kind]);
  if (rec) {
    form.elements.id.value = rec.yotpo_id;
    toast(`Found Yotpo ID ${rec.yotpo_id}. Loading…`);
    await (kind === "products" ? puUpdate : ouUpdate).load();
  } else if (out.ok) toast(`No ${kind.slice(0, -1)} with external ID "${ext}"`);
})));

// "Edit" buttons in result tables open the update form and load the record.
$("#resTable").addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const isProduct = b.dataset.action === "editProduct";
  const [tab, form, ctl] = isProduct ? ["products", puForm, puUpdate] : ["orders", ouForm, ouUpdate];
  $(`.tab[data-tab="${tab}"]`).click();
  openSub(tab, "update");
  form.elements.id.value = b.dataset.id;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  withBusy($("[data-load]", form), ctl.load);
});

// ---------- Reviews ----------

onSubmit("#reviewsList", async (f) => {
  const sid = requireStoreId();
  const token = requireToken();
  const url = `${API}/v1/apps/${sid}/reviews${qs({
    count: f.elements.count.value,
    page: f.elements.page.value,
    since_date: f.elements.since_date.value,
    since_updated_at: f.elements.since_updated_at.value,
    user_reference: f.elements.user_reference.value.trim(),
    deleted: f.elements.deleted.checked ? "true" : "",
    utoken: token, // older v1 endpoints read the token from the query string
  })}`;
  const out = await api("GET", url);
  const rows = out.data?.reviews || [];
  const count = Number(f.elements.count.value) || 10;
  setNext("reviewsList", out.ok && rows.length >= count ? String((Number(f.elements.page.value) || 1) + 1) : "");
  showResult({ ...out, url: url.replace(/utoken=[^&]+/, "utoken=…") }, rows, COLS.reviews,
    out.ok ? `${rows.length} reviews on page ${f.elements.page.value}` : "");
});

onSubmit("#reviewsById", async (f) => {
  const id = encodeURIComponent(f.elements.id.value.trim());
  const out = await api("GET", `${API}/reviews/${id}`, { auth: false });
  const review = out.data?.response?.review;
  showResult(out, review ? kvRows(review) : [], KV_COLS);
});

onSubmit("#reviewsByProduct", async (f) => {
  const sid = requireStoreId();
  const pid = encodeURIComponent(f.elements.productId.value.trim());
  const url = `${CDN}/v1/widget/${sid}/products/${pid}/reviews.json${qs({
    per_page: f.elements.per_page.value,
    page: f.elements.page.value,
    star: f.elements.star.value,
    sort: f.elements.sort.value,
    direction: f.elements.direction.value,
  })}`;
  const out = await api("GET", url, { auth: false });
  const r = out.data?.response;
  const bl = r?.bottomline;
  const summary = bl ? `${bl.total_review} total reviews · average ${Number(bl.average_score).toFixed(2)} · page ${r.pagination?.page} of ${Math.max(1, Math.ceil((r.pagination?.total || 0) / (r.pagination?.per_page || 1)))}` : "";
  showResult(out, r?.reviews || [], COLS.widgetReviews, out.ok ? summary : "");
});

// Create review
const rvForm = $("#reviewsCreate");
const rv = (n) => rvForm.elements[`rv_${n}`];
const rvIsSite = () => val(rv("type")) === "site";
const rvScore = () => rvForm.querySelector('[name="rv_score"]:checked')?.value || "5";

const rvCreate = setupCreateForm(rvForm, {
  build() {
    const site = rvIsSite();
    const incentivized = rv("is_incentivized").checked;
    return {
      appkey: storeIdEl.value.trim(),
      sku: site ? "yotpo_site_reviews" : val(rv("sku")),
      product_title: val(rv("product_title")),
      product_url: val(rv("product_url")),
      display_name: val(rv("display_name")),
      email: val(rv("email")),
      review_title: val(rv("review_title")),
      review_content: val(rv("review_content")),
      review_score: Number(rvScore()),
      ...compact({
        product_image_url: site ? undefined : val(rv("product_image_url")),
        product_description: site ? undefined : val(rv("product_description")),
        is_incentivized: incentivized || undefined,
        incentive_type: incentivized ? val(rv("incentive_type")) : undefined,
        delivery_type: val(rv("delivery_type")),
        order_metadata: { coupon_used: rv("coupon_used").checked || undefined },
        customer_metadata: { country: upper(rv("country")), state: val(rv("state")) },
        product_metadata: site ? undefined : { color: val(rv("color")), size: val(rv("size")) },
      }),
    };
  },
  populate(b) {
    rvForm.reset();
    const site = b.sku === "yotpo_site_reviews";
    rv("type").value = site ? "site" : "product";
    setVal(rv("sku"), site ? "" : b.sku);
    for (const k of ["product_title", "product_url", "product_image_url", "product_description", "display_name",
      "email", "review_title", "review_content", "incentive_type", "delivery_type"]) setVal(rv(k), b[k]);
    const score = rvForm.querySelector(`[name="rv_score"][value="${Number(b.review_score) || 5}"]`);
    if (score) score.checked = true;
    rv("is_incentivized").checked = !!b.is_incentivized;
    rv("coupon_used").checked = !!b.order_metadata?.coupon_used;
    setVal(rv("country"), b.customer_metadata?.country);
    setVal(rv("state"), b.customer_metadata?.state);
    setVal(rv("color"), b.product_metadata?.color);
    setVal(rv("size"), b.product_metadata?.size);
  },
  validate() {
    const v = validator(rvForm);
    if (!rvIsSite() && v.need(rv("sku"))) {
      v.rule(rv("sku"), (s) => /^[A-Za-z0-9_-]+$/.test(s), "Only letters, numbers, _ and - are allowed");
    }
    v.need(rv("product_title"));
    if (v.need(rv("product_url"))) v.rule(rv("product_url"), isUrl, "Must start with http:// or https://");
    v.rule(rv("product_image_url"), isUrl, "Must start with http:// or https://");
    v.need(rv("display_name"));
    if (v.need(rv("email"))) v.rule(rv("email"), isEmail, "Enter a valid email");
    v.need(rv("review_title"));
    v.need(rv("review_content"));
    v.rule(rv("country"), (s) => /^[A-Za-z]{2}$/.test(s), "Use a 2-letter code, e.g. US");
    return v.done();
  },
  sync() {
    const site = rvIsSite();
    $$("[data-product-only]", rvForm).forEach((el) => (el.hidden = site));
    rv("product_title").placeholder = site ? "Store name" : "";
    rv("product_url").placeholder = site ? "https://store-homepage.com" : "https://";
    rv("incentive_type").disabled = !rv("is_incentivized").checked;
    $("#rvScoreText").textContent = `${rvScore()} / 5`;
    const len = rv("review_content").value.length;
    $("#rvContentCount").textContent = `${len} character${len === 1 ? "" : "s"}`;
  },
});

// Fill product title/URL/image from the catalog by external product ID
$("#rvFillProduct").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
  const sku = val(rv("sku"));
  if (!sku) { rv("sku").focus(); return toast("Enter the product ID first"); }
  const sid = requireStoreId();
  const out = await api("GET", `${CORE}/${sid}/products${qs({ external_ids: sku })}`);
  if (!out.ok) return showResult(out);
  const p = out.data?.products?.[0];
  if (!p) return toast(`No product with ID "${sku}" in the catalog`);
  setVal(rv("product_title"), p.name);
  setVal(rv("product_url"), p.url);
  setVal(rv("product_image_url"), p.image_url);
  if (!val(rv("product_description"))) setVal(rv("product_description"), p.description);
  clearErrors(rvForm);
  toast(`Filled from "${p.name}"`);
}));

onSubmit("#reviewsCreate", async () => {
  requireStoreId();
  const body = rvCreate.body();
  if (!body) return;
  if (!confirmWrite(`Create a ${body.review_score || "?"}-star review`, `for SKU ${body.sku || ""} by ${body.email || ""}\n(the reviewer gets a verification email)`)) return;
  const out = await api("POST", `${API}/v1/widget/reviews`, { body });
  showResult(out, null, null, out.ok ? "Review submitted. Creation is asynchronous, so it can take a while to appear." : "");
  if (out.ok) toast("Review submitted");
});

const reviewUpdateForm = $("#reviewsUpdate");
function syncReviewMode() {
  const mode = reviewUpdateForm.elements.mode.value;
  $('[data-show="metadata"]', reviewUpdateForm).hidden = mode !== "metadata";
  loadTemplate("reviewUpdate");
}
reviewUpdateForm.elements.mode.addEventListener("change", syncReviewMode);
syncReviewMode();

onSubmit("#reviewsUpdate", async (f) => {
  const sid = requireStoreId();
  const body = parseBody(f);
  let url;
  if (f.elements.mode.value === "metadata") {
    const id = f.elements.id.value.trim();
    if (!id) return toast("Enter the Review ID");
    url = `${API}/v1/apps/${sid}/reviews/${encodeURIComponent(id)}/metadata`;
    if (!confirmWrite("Update metadata for review", id)) return;
  } else {
    url = `${API}/v1/apps/${sid}/reviews/incentivized_badge`;
    if (!confirmWrite("Update incentivized badge for", `${body?.reviews?.length || 0} review(s)`)) return;
  }
  const out = await api("PUT", url, { body });
  showResult(out, null, null, out.ok ? (out.data?.status?.message || "Updated.") : "");
  if (out.ok) toast("Review updated");
});

// ---------- Widgets (explorer + live preview) ----------
// Yotpo's loader script runs inside widget-frame.html, so its global styles
// and scripts stay out of this page. The frame reports back via postMessage.

const widgetsForm = $("#widgetsLoad");
const listFrame = $("#widgetListFrame");
const previewFrame = $("#widgetPreviewFrame");
let widgetState = { appKey: "", widgets: [], previewId: "" };

widgetsForm.elements.appKey.value = storeIdEl.value.trim();
storeIdEl.addEventListener("input", () => {
  if (!widgetState.appKey) widgetsForm.elements.appKey.value = storeIdEl.value.trim();
});

function widgetStatus(text, isErr = false) {
  const el = $("#widgetsStatus");
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

function frameUrl(params) {
  return `widget-frame.html${qs(params)}`;
}

widgetsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const appKey = widgetsForm.elements.appKey.value.trim();
  widgetState = { appKey, widgets: [], previewId: "" };
  $("#widgetsTable").hidden = true;
  $("#widgetsFilterRow").hidden = true;
  $("#widgetPreviewCard").hidden = true;
  widgetStatus("Loading the Yotpo widget loader…");
  listFrame.src = frameUrl({ appKey, t: Date.now() });
});

function renderWidgets() {
  const filter = $("#widgetsFilter").value;
  const rows = widgetState.widgets.filter((w) => !filter || w.className === filter);
  const body = rows.map((w) => `<tr>
      <td class="num">${esc(w.instanceId)}</td>
      <td>${esc(w.className)}</td>
      <td>${esc(w.version || "—")}</td>
      <td>${w.cssOverrideAssetUrl ? `<a href="${esc(w.cssOverrideAssetUrl)}" target="_blank" rel="noopener">View CSS</a>` : "—"}</td>
      <td><button type="button" data-preview="${esc(w.instanceId)}">Preview</button></td>
    </tr>`).join("");
  $("#widgetsTable").innerHTML = rows.length
    ? `<table><thead><tr><th>Instance ID</th><th>Widget type</th><th>Version</th><th>CSS override</th><th>Preview</th></tr></thead><tbody>${body}</tbody></table>`
    : `<div class="empty">No widgets of this type.</div>`;
  $("#widgetsTable").hidden = false;
}
$("#widgetsFilter").addEventListener("change", renderWidgets);

function previewWidget(instanceId) {
  const w = widgetState.widgets.find((x) => x.instanceId === instanceId);
  widgetState.previewId = instanceId;
  const productId = $("#widgetsProductId").value.trim();
  const reviewId = widgetsReview.elements.reviewId.value.trim();
  $("#widgetPreviewTitle").textContent = `Widget preview: ${w?.className || ""} (${instanceId})` +
    `${productId ? `, product ${productId}` : ""}${reviewId ? `, review ${reviewId}` : ""}`;
  previewFrame.style.height = "200px";
  previewFrame.src = frameUrl({ appKey: widgetState.appKey, instanceId, productId, reviewId, t: Date.now() });
  $("#widgetPreviewCard").hidden = false;
  $("#widgetPreviewCard").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#widgetsTable").addEventListener("click", (e) => {
  const b = e.target.closest("[data-preview]");
  if (b) previewWidget(b.dataset.preview);
});

// Review lookup: fetch one review, fill in its product so the preview shows
// that product's widget, and have the preview frame highlight the review.
const widgetsReview = $("#widgetsReview");

function reviewProduct(review) {
  const p = (review.products || []).map((x) => x.Product || x.product || x)[0];
  return { id: p?.domain_key || review.sku || "", name: p?.name || "" };
}

onSubmit("#widgetsReview", async (f) => {
  const id = f.elements.reviewId.value.trim();
  if (!id) { toast("Enter a review ID first."); return; }
  const out = await api("GET", `${API}/reviews/${encodeURIComponent(id)}`, { auth: false });
  const review = out.data?.response?.review;
  if (!out.ok || !review) {
    if (out.ok) showResult(out);
    $("#widgetsReviewCard").hidden = true;
    return;
  }
  const product = reviewProduct(review);
  if (product.id) $("#widgetsProductId").value = product.id;
  const score = Math.max(0, Math.min(5, Number(review.score) || 0));
  $("#widgetsReviewCard").innerHTML = `
    <div class="rc-head">
      <span class="rc-stars" aria-label="${score} out of 5">${"★".repeat(score)}${"☆".repeat(5 - score)}</span>
      <span>Review ${esc(review.id)}</span>
      <span>${esc(review.user?.display_name || "")}</span>
      <span>${esc(fmtDate(review.created_at))}</span>
      ${review.verified_buyer ? "<span>Verified buyer</span>" : ""}
      <span>${product.id ? `Product ${esc(product.id)}${product.name ? ` (${esc(decodeEntities(product.name))})` : ""}` : "Site review"}</span>
    </div>
    <p class="rc-title">${esc(decodeEntities(review.title || ""))}</p>
    <p class="rc-body">${esc(decodeEntities(review.content || ""))}</p>`;
  $("#widgetsReviewCard").hidden = false;
  toast(product.id ? `Product ID set to ${product.id}. Click Preview on a reviews widget.` : "Review found. It isn't tied to a product.");
  if (widgetState.previewId) previewWidget(widgetState.previewId);
});

$("#clearReview").addEventListener("click", () => {
  widgetsReview.elements.reviewId.value = "";
  $("#widgetsReviewCard").hidden = true;
});

$("#closePreview").addEventListener("click", () => {
  $("#widgetPreviewCard").hidden = true;
  previewFrame.src = "about:blank";
  widgetState.previewId = "";
});

$("#copyEmbed").addEventListener("click", async () => {
  const productId = $("#widgetsProductId").value.trim();
  const code = `<script src="https://cdn-widgetsrepository.yotpo.com/v1/loader/${widgetState.appKey}" async></script>\n` +
    `<div class="yotpo-widget-instance" data-yotpo-instance-id="${widgetState.previewId}"` +
    `${productId ? ` data-yotpo-product-id="${productId}"` : ""}></div>`;
  try { await navigator.clipboard.writeText(code); toast("Embed code copied"); }
  catch { toast("Couldn't access the clipboard"); }
});

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.data?.source !== "yotpo-widget-frame") return;
  const fromList = e.source === listFrame.contentWindow;
  const fromPreview = e.source === previewFrame.contentWindow;
  const msg = e.data;

  if (fromList && msg.type === "widgets") {
    widgetState.widgets = msg.widgets.sort((a, b) => Number(a.instanceId) - Number(b.instanceId));
    widgetStatus(`Loaded ${msg.widgets.length} widget(s) for ${msg.appKey}.`);
    const types = [...new Set(msg.widgets.map((w) => w.className))].sort();
    $("#widgetsFilter").innerHTML = `<option value="">All types (${msg.widgets.length})</option>` +
      types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    $("#widgetsFilterRow").hidden = false;
    renderWidgets();
    listFrame.src = "about:blank"; // list captured; free the frame
  } else if (fromList && msg.type === "error") {
    widgetStatus(msg.message, true);
  } else if (fromPreview && msg.type === "height") {
    previewFrame.style.height = `${Math.max(200, msg.height)}px`;
  } else if (fromPreview && msg.type === "review") {
    if (msg.found) {
      window.scrollTo({ top: previewFrame.getBoundingClientRect().top + window.scrollY + msg.top - 80, behavior: "smooth" });
    } else {
      toast(`Review ${msg.reviewId} isn't on this widget's first page. Try sorting or paging in the widget.`, 4500);
    }
  } else if (fromPreview && msg.type === "error") {
    toast(msg.message, 4000);
  }
});

// ---------- Connector install card (hosted version only) ----------
// Websites can't install extensions themselves, so the button either opens the
// Chrome Web Store listing (when config.js has one) or guides a manual install.
// Once installed, the extension reloads this page and the card disappears.

if (!IS_LOCAL && hasConnector()) {
  $(".sidebar-foot").insertAdjacentHTML("afterbegin",
    `<div class="connector-ok"><span class="pill ok">Connector ${esc(document.documentElement.dataset.yotpoConnector)}</span></div>`);
}

if (!IS_LOCAL && !hasConnector() && !PROXY_URL) {
  const storeUrl = (window.YOTPO_TOOL_CONFIG?.connectorStoreUrl || "").trim();
  const ua = navigator.userAgent;
  const isEdge = ua.includes("Edg/");
  const isChromium = !!window.chrome && /Chrome\//.test(ua);
  const extPage = isEdge ? "edge://extensions" : "chrome://extensions";

  $(".content").insertAdjacentHTML("afterbegin", `
    <section class="install-card" id="installCard">
      <div class="install-head">
        <span class="install-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
        </span>
        <div class="install-text">
          <h2>Install the Yotpo Tool Connector</h2>
          <p>A one-time setup. This small browser extension lets the tool call Yotpo without CORS errors.
             It only runs on this site and only talks to Yotpo. Until it's installed, only the Widgets tab works.</p>
        </div>
        ${isChromium
          ? `<button type="button" class="install-btn" id="installBtn">${storeUrl ? "Add to Chrome" : "Install connector"}</button>`
          : ""}
      </div>
      ${isChromium ? "" : `<p class="install-note">Please open this page in <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> to install the connector.</p>`}
      <div class="install-steps" id="installSteps" hidden>
        ${storeUrl
          ? `<p class="install-note">The Chrome Web Store opened in a new tab. Click <strong>Add to Chrome</strong> there.
               This page reloads automatically once it's installed.</p>`
          : `<ol>
               <li><span class="step-n">1</span><div><strong>Unzip the download.</strong>
                 Find <code>${CONNECTOR_ZIP}</code> in your Downloads, right-click it and choose <strong>Extract All</strong>.
                 <a href="${CONNECTOR_ZIP}" download>Download again</a></div></li>
               <li><span class="step-n">2</span><div><strong>Open the extensions page.</strong>
                 Browsers don't let websites open it, so copy this address into a new tab:
                 <span class="copy-line"><code>${extPage}</code><button type="button" class="ghost small" id="copyExtPage">Copy</button></span></div></li>
               <li><span class="step-n">3</span><div><strong>Load it.</strong> Turn on <strong>Developer mode</strong>,
                 click <strong>Load unpacked</strong>, and select the unzipped folder (the one with <code>manifest.json</code>).</div></li>
             </ol>
             <p class="install-note">This page reloads automatically once the connector is installed.</p>`}
      </div>
    </section>`);

  $("#installBtn")?.addEventListener("click", () => {
    if (storeUrl) {
      window.open(storeUrl, "_blank", "noopener");
    } else {
      const a = document.createElement("a");
      a.href = CONNECTOR_ZIP;
      a.download = CONNECTOR_ZIP;
      a.click();
      toast("Downloading the connector. Follow the steps below.", 3500);
    }
    $("#installSteps").hidden = false;
    $("#installSteps").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#copyExtPage")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(extPage); toast(`Copied ${extPage}. Paste it into a new tab.`); }
    catch { toast(`Couldn't copy. Type ${extPage} into a new tab.`); }
  });
}
