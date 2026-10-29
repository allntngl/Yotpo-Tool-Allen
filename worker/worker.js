// Yotpo Tool - Cloudflare Worker proxy.
// Does the same job as server.js for the hosted (GitHub Pages) version of the
// tool: the page POSTs to /proxy, and the Worker calls Yotpo server-side, so
// the browser never hits Yotpo directly and there are no CORS errors.
//
// Setting (Worker > Settings > Variables):
//   ALLOWED_ORIGINS  Comma-separated origins allowed to use this proxy,
//                    e.g. "https://your-user.github.io". Required.

// Only these hosts can be reached through the proxy.
const ALLOWED_HOSTS = new Set(["api.yotpo.com", "api-cdn.yotpo.com"]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
    const originOk = allowed.includes(origin);

    const cors = originOk
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        }
      : { Vary: "Origin" };
    const json = (status, data) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
      });

    const { pathname } = new URL(request.url);
    if (pathname === "/" && request.method === "GET") {
      return new Response("Yotpo Tool proxy is running.", { headers: { "Content-Type": "text/plain" } });
    }
    if (pathname !== "/proxy") return json(404, { error: "Not found" });
    if (!originOk) {
      return json(403, { error: `Origin not allowed: ${origin || "(none)"}. Add it to the Worker's ALLOWED_ORIGINS variable.` });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
      return json(413, { error: "Request body too large" });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(400, { error: "Invalid JSON sent to proxy" });
    }

    const { method = "GET", url, token, body } = payload;
    const m = String(method).toUpperCase();

    let target;
    try {
      target = new URL(url);
    } catch {
      return json(400, { error: "Invalid URL" });
    }
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
      return json(400, { error: `Host not allowed: ${target.hostname}` });
    }
    if (!ALLOWED_METHODS.has(m)) return json(400, { error: `Method not allowed: ${m}` });

    const headers = { Accept: "application/json" };
    if (token) headers["X-Yotpo-Token"] = token;
    const init = { method: m, headers };
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
      return json(200, {
        status: upstream.status,
        statusText: upstream.statusText,
        ms: Date.now() - started,
        headers: keep,
        body: text,
      });
    } catch (err) {
      return json(502, { error: `Could not reach Yotpo: ${err.message}` });
    }
  },
};
