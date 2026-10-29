// Makes the Yotpo API calls for the Yotpo Tool page. Extensions with host
// permissions aren't subject to CORS, so these calls succeed where the page's
// own calls would be blocked. Same request/response shape as server.js.

// Only these hosts can be reached, and only the tool's page can ask.
const ALLOWED_HOSTS = new Set(["api.yotpo.com", "api-cdn.yotpo.com"]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_PAGE = "https://allntngl.github.io/Yotpo-Tool-Allen/";

// Reload open tool tabs after install or update so the page picks up the
// connector straight away (content scripts only attach on page load).
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: `${ALLOWED_PAGE}*` });
  for (const tab of tabs) chrome.tabs.reload(tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "proxy") return false;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(ALLOWED_PAGE)) {
    sendResponse({ error: "Request not allowed from this page" });
    return false;
  }
  proxy(msg.payload).then(sendResponse);
  return true; // keep the channel open for the async reply
});

async function proxy(payload = {}) {
  const { method = "GET", url, token, body } = payload;
  const m = String(method).toUpperCase();

  let target;
  try {
    target = new URL(url);
  } catch {
    return { error: "Invalid URL" };
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return { error: `Host not allowed: ${target.hostname}` };
  }
  if (!ALLOWED_METHODS.has(m)) return { error: `Method not allowed: ${m}` };

  const headers = { Accept: "application/json" };
  if (token) headers["X-Yotpo-Token"] = token;
  const init = { method: m, headers, credentials: "omit" };
  if (body !== undefined && body !== null && m !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const started = Date.now();
  try {
    const upstream = await fetch(target, init);
    const text = await upstream.text();
    const keep = {};
    for (const [k, v] of upstream.headers) {
      if (k.startsWith("ratelimit") || k.startsWith("x-ratelimit") || k === "content-type") keep[k] = v;
    }
    return {
      status: upstream.status,
      statusText: upstream.statusText,
      ms: Date.now() - started,
      headers: keep,
      body: text,
    };
  } catch (err) {
    return { error: `Could not reach Yotpo: ${err.message}` };
  }
}
