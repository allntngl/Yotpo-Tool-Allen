// Yotpo Tool - local proxy server (no dependencies, Node 18+).
// Serves the dashboard from ./public and forwards API calls to Yotpo,
// which avoids browser CORS errors.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// Only these hosts can be reached through the proxy.
const ALLOWED_HOSTS = new Set(["api.yotpo.com", "api-cdn.yotpo.com"]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleProxy(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON sent to proxy" });
  }

  const { method = "GET", url, token, body } = payload;
  const m = String(method).toUpperCase();

  let target;
  try {
    target = new URL(url);
  } catch {
    return sendJson(res, 400, { error: "Invalid URL" });
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return sendJson(res, 400, { error: `Host not allowed: ${target.hostname}` });
  }
  if (!ALLOWED_METHODS.has(m)) {
    return sendJson(res, 400, { error: `Method not allowed: ${m}` });
  }

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
    const ms = Date.now() - started;
    console.log(`${new Date().toISOString()}  ${m} ${target.pathname}${target.search}  -> ${upstream.status} (${ms}ms)`);

    const keep = {};
    for (const [k, v] of upstream.headers) {
      if (k.startsWith("ratelimit") || k.startsWith("x-ratelimit") || k === "content-type") keep[k] = v;
    }
    sendJson(res, 200, {
      status: upstream.status,
      statusText: upstream.statusText,
      ms,
      headers: keep,
      body: text,
    });
  } catch (err) {
    console.error(`${m} ${target.pathname} failed:`, err.message);
    sendJson(res, 502, { error: `Could not reach Yotpo: ${err.message}` });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/proxy") return handleProxy(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end("Method not allowed");
});

// Bind to localhost only so the tool isn't exposed on the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Yotpo Tool running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
