// howl-funscript-events-studio - options shell broker
// 沙箱页(sandbox.html)不能使用 chrome.* API，本壳负责桥接：
//   getStore  -> chrome.storage.local.get(['settings','scripts'])
//   setStore  -> chrome.storage.local.set(patch)
//   bg        -> chrome.runtime.sendMessage（转发给 background service worker）

const HANDLERS = {
  async getStore() {
    const d = await chrome.storage.local.get(['settings', 'scripts']);
    return { settings: d.settings || {}, scripts: Array.isArray(d.scripts) ? d.scripts : [] };
  },
  async setStore(patch) {
    await chrome.storage.local.set(patch);
    return true;
  },
  async bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r || { ok: false, error: 'background 无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }
};

window.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || msg.__hfes_bridge__ !== true || msg.kind !== 'request' || !msg.id) return;
  let response;
  try {
    const handler = HANDLERS[msg.type];
    if (!handler) throw new Error('unknown bridge type: ' + msg.type);
    const result = await handler(msg.payload);
    response = { ok: true, result };
  } catch (err) {
    response = { ok: false, error: String((err && err.message) || err) };
  }
  e.source.postMessage({ __hfes_bridge__: true, kind: 'response', id: msg.id, ok: response.ok, result: response.result, error: response.error }, '*');
});
