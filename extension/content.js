// Runs on the Yotpo Tool page only. Relays the page's API requests to the
// extension's background worker and sends the answers back to the page.

// Lets the page know the connector is installed (read by app.js).
document.documentElement.dataset.yotpoConnector = chrome.runtime.getManifest().version;

window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const msg = e.data;
  if (!msg || msg.source !== "yotpo-tool-page" || msg.type !== "request") return;

  chrome.runtime.sendMessage({ type: "proxy", payload: msg.payload }, (reply) => {
    const err = chrome.runtime.lastError;
    window.postMessage(
      {
        source: "yotpo-connector",
        type: "response",
        id: msg.id,
        reply: err ? { error: `Connector error: ${err.message}. Try reloading the page.` } : reply,
      },
      location.origin
    );
  });
});
