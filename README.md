# Yotpo Tool

A web console for support agents working with the Yotpo APIs: generate an access token (U-Token), then create, update and retrieve products, orders and reviews, and preview a store's on-site widgets.

**Team link: https://allntngl.github.io/Yotpo-Tool-Allen/**

Ways to run it:

- **Website + Connector extension (recommended for teams):** open the link and install the small Yotpo Tool Connector Chrome extension once. Nothing else to set up.
- **Website + Cloudflare Worker (optional):** no extension needed for agents, but someone has to deploy a Worker once. See "Cloudflare Worker setup" below.
- **Local:** run `npm start` and open http://localhost:3000. Needs Node.js 18+.

## Why a proxy is needed (CORS)

Browsers block web pages from calling `api.yotpo.com` directly, which shows up as a CORS error. So the page never calls Yotpo itself. Something outside the page makes the call, where CORS doesn't apply:

- On the website: the Connector extension (`extension/`), or a Cloudflare Worker (`worker/worker.js`) if `config.js` sets one.
- Locally: `server.js`.

All of them only forward to `https://api.yotpo.com` and `https://api-cdn.yotpo.com`, and store nothing.

## Installing the Connector extension (each agent, once)

Open the team link. Until the extension is installed, the page shows an **Install** card.

- **Once it's on the Chrome Web Store** (see `docs/chrome-web-store.md`): click **Add to Chrome**, then **Add to Chrome** again on the store page. The tool page reloads itself, ready to use.
- **Until then:** click **Install connector**. It downloads `yotpo-tool-connector.zip` and shows three steps: unzip, open `chrome://extensions` and turn on **Developer mode**, then **Load unpacked** and pick the unzipped folder. The tool page reloads itself once it's installed.

Websites can't install extensions on their own, so one of these is always needed. For zero clicks, company IT can force-install it from the Web Store.

The extension only runs on `https://allntngl.github.io/Yotpo-Tool-Allen/` and only has access to the two Yotpo API hosts. It doesn't read other sites. If your company's Chrome policy blocks Developer mode, ask IT to allow the extension, or use the Cloudflare Worker option instead.

When the extension changes, agents download the new zip, then click the reload icon on the extension's card in `chrome://extensions`.

## Cloudflare Worker setup (optional, one time)

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

## Publishing the site (GitHub Pages)

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
