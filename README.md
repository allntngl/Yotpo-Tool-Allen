# Yotpo Tool

A web console for support agents working with the Yotpo APIs: generate an access token (U-Token), then create, update and retrieve products, orders and reviews, and preview a store's on-site widgets.

There are two ways to run it:

- **Hosted (recommended for teams):** the page runs on GitHub Pages and API calls go through a small Cloudflare Worker. Agents just open the link. Nothing to install.
- **Local:** run `npm start` and open http://localhost:3000. Needs Node.js 18+.

## Why a proxy is needed (CORS)

Browsers block web pages from calling `api.yotpo.com` directly, which shows up as a CORS error. So the page never calls Yotpo itself. It sends each request to a proxy, and the proxy makes the call server-side, where CORS doesn't apply.

- Locally, the proxy is `server.js`.
- Hosted, the proxy is the Cloudflare Worker in `worker/worker.js`.

Both proxies only forward to `https://api.yotpo.com` and `https://api-cdn.yotpo.com`, and store nothing. The Worker only accepts requests from the sites listed in its `ALLOWED_ORIGINS` setting.

## Hosted setup (one time, about 10 minutes)

### 1. Deploy the Cloudflare Worker

1. Sign in at https://dash.cloudflare.com (the free plan is enough).
2. Go to **Workers & Pages → Create → Create Worker**. Name it, for example, `yotpo-tool-proxy`, and click **Deploy**.
3. Click **Edit code**, replace everything with the contents of `worker/worker.js`, and click **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets → Add**:
   - Name: `ALLOWED_ORIGINS`
   - Value: your GitHub Pages origin, e.g. `https://your-user.github.io` (no path, no trailing slash)
   - Click **Deploy**.
5. Copy the Worker's URL, e.g. `https://yotpo-tool-proxy.your-name.workers.dev`. Opening it should show "Yotpo Tool proxy is running."

### 2. Point the tool at the Worker

Edit `public/config.js` and set `proxyUrl` to the Worker URL plus `/proxy`:

```js
window.YOTPO_TOOL_CONFIG = {
  proxyUrl: "https://yotpo-tool-proxy.your-name.workers.dev/proxy",
};
```

Commit and push.

### 3. Turn on GitHub Pages

In the GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The workflow in `.github/workflows/pages.yml` publishes the `public/` folder on every push to `main`. After it runs, the site is at `https://your-user.github.io/your-repo/`. Share that link with the team.

### Troubleshooting

- **"Setup needed" banner on the site:** `proxyUrl` in `config.js` is empty.
- **"Origin not allowed":** the Worker's `ALLOWED_ORIGINS` doesn't match the site's origin exactly. It should look like `https://your-user.github.io`.
- **"Can't reach the proxy":** check that `proxyUrl` ends in `/proxy` and that the Worker is deployed.

## Local setup

```
npm start
```

Then open http://localhost:3000. On localhost the tool always uses the local server, whatever `config.js` says.

## Security notes

- Each agent enters their own Store ID and API secret. The secret is never stored; the token is kept only for the browser tab's session.
- No credentials or keys are in this repo. Don't commit any.
- GitHub Pages sites are public. The page contains no secrets, and the Worker only works for the allowed site and only talks to Yotpo, but anyone with the link can open the page.

## What each tab does

| Tab | Retrieve | Retrieve by ID | Create | Update |
|---|---|---|---|---|
| Authentication | — | — | Generate access token | — |
| Products | All products (paged) | Yotpo product ID or external IDs | Form or JSON | Load, edit, send only changes |
| Orders | All orders (paged, date filters) | Yotpo or external order ID; by product ID (scans orders) | Form or JSON, with line items and fulfillment | Load, edit, send only changes; add a fulfillment |
| Reviews | All reviews | Review ID; external product ID | Form or JSON | Review metadata, or incentivized badge |
| Widgets | Widget instances for an app key | — | — | Live preview and embed code |

Notes:
- Create and update ask for confirmation first, because they write to the live store.
- Yotpo's API can't edit a review's text or score, and can't clear a field's value.
- Orders have no product filter in the API, so "by product ID" pages through orders and matches line items locally.
