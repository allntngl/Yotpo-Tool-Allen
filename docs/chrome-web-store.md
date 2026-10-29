# Publishing the Yotpo Tool Connector to the Chrome Web Store

Websites can't install Chrome extensions themselves. Publishing the connector to the Chrome Web Store is what turns the tool's **Install** button into a two-click install for agents: click **Add to Chrome** on the store page, and the tool page reloads itself ready to use. No Developer mode, no zip files.

Publish it as **Unlisted**: it won't appear in store search, and only people with the link (your team, via the tool's button) can install it.

## What you need

- A Google account for the Chrome Web Store developer dashboard (one-time $5 registration fee).
- The extension zip: download `https://allntngl.github.io/Yotpo-Tool-Allen/yotpo-tool-connector.zip`. It's rebuilt from the `extension/` folder on every push.
- A screenshot of the tool (1280×800 or 640×400). A screenshot of the tool's Orders or Products tab works well.

## Steps

1. Go to https://chrome.google.com/webstore/devconsole and register (one-time fee).
2. Click **New item** and upload `yotpo-tool-connector.zip`.
3. **Store listing** tab: fill in the fields using the text below, and upload the icon (`extension/icons/icon128.png`) and a screenshot.
4. **Privacy** tab: use the answers below.
5. **Distribution** tab: set **Visibility** to **Unlisted**.
6. Click **Submit for review**. Review usually takes a few days.
7. When it's approved, copy the item's store URL (`https://chromewebstore.google.com/detail/...`) and put it in `public/config.js`:

   ```js
   connectorStoreUrl: "https://chromewebstore.google.com/detail/yotpo-tool-connector/<id>",
   ```

   Commit and push. The tool's button now says **Add to Chrome** and opens the store.

To release an update later: bump `"version"` in `extension/manifest.json`, push, download the new zip, and upload it under **Package → Upload new package**. Chrome updates installed copies automatically.

## Listing text (copy and paste)

**Name:** Yotpo Tool Connector

**Summary:**
Lets the Yotpo Tool support console call the Yotpo APIs without CORS errors.

**Description:**
Companion extension for the Yotpo Tool support console (https://allntngl.github.io/Yotpo-Tool-Allen/).

Browsers block web pages from calling the Yotpo APIs directly. This extension makes those calls on behalf of the Yotpo Tool page so support agents can generate access tokens and look up, create and update products, orders and reviews.

- Runs only on the Yotpo Tool site.
- Only connects to api.yotpo.com and api-cdn.yotpo.com.
- Stores nothing, has no settings, and doesn't read or change any other website.

**Category:** Developer Tools (or Productivity)

**Language:** English

## Privacy tab answers

**Single purpose:**
Relays API requests from the Yotpo Tool support console page to the Yotpo APIs, so the page can work without CORS errors.

**Permission justifications:**

- **Host permission `https://api.yotpo.com/*` and `https://api-cdn.yotpo.com/*`:** the extension sends the tool's API requests to these Yotpo endpoints and returns the responses to the tool page. These are the only hosts it contacts.
- **Host permission `https://allntngl.github.io/Yotpo-Tool-Allen/*` (and the content script on it):** the content script relays requests between the Yotpo Tool page and the extension. After install or update, the extension reloads open Yotpo Tool tabs so the connector is active immediately.

**Remote code:** No, the extension doesn't use remote code.

**Data usage:** The extension passes the user's Yotpo access token and API request data from the Yotpo Tool page to Yotpo's API, and returns Yotpo's response to that page. It doesn't store, log, sell or share any data with anyone else.

Tick the data categories that apply, typically **Authentication information** (the Yotpo access token in transit) and **Personally identifiable information** (customer names and emails in orders and reviews), and certify that the data is:
- not sold to third parties,
- not used or transferred for purposes unrelated to the item's single purpose,
- not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** `https://allntngl.github.io/Yotpo-Tool-Allen/privacy.html` (published from `public/privacy.html`).

## Zero-click alternative: company IT

If your team uses company-managed Chrome, IT can force-install the extension for everyone once it's in the Web Store (policy `ExtensionInstallForcelist` with the extension's ID). Agents then don't need to do anything at all.
