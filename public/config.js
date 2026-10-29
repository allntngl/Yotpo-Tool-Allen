// Hosted-version settings.
window.YOTPO_TOOL_CONFIG = {
  // Chrome Web Store page of the Yotpo Tool Connector, once it's published,
  // e.g. "https://chromewebstore.google.com/detail/yotpo-tool-connector/<id>".
  // When set, the page's install button opens it ("Add to Chrome" in two clicks).
  // When empty, the button downloads the zip and walks through a manual install.
  connectorStoreUrl: "",

  // Optional alternative to the extension: a Cloudflare Worker's /proxy URL, e.g.
  // "https://yotpo-tool-proxy.your-name.workers.dev/proxy" (see the README).
  // On localhost (npm start) the local server is always used instead.
  proxyUrl: "",
};
