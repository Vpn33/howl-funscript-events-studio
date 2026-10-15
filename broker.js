// howl-funscript-events-studio - options shell broker
// 沙箱页(sandbox.html)不能使用 chrome.* API，本壳负责桥接：
//   getStore  -> chrome.storage.local.get(['settings','scripts'])
//   setStore  -> chrome.storage.local.set(patch)
//   bg        -> chrome.runtime.sendMessage（转发给 background service worker）

const HANDLERS = {
  async getStore() {
    const d = await chrome.storage.local.get(['settings','scripts','domainRuleGroups']);
    return { 
      settings: d.settings || {}, 
      scripts: Array.isArray(d.scripts) ? d.scripts : [],
      domainRuleGroups: Array.isArray(d.domainRuleGroups) ? d.domainRuleGroups : [] 
    };
  },
  async setStore(patch) {
    await chrome.storage.local.set(patch);
    return true;
  },
  async openEditorTab(scriptId, eventId) {
    // 查找已打开的包含 sandbox.html 的 tab
    const allTabs = await chrome.tabs.query({ active: false, currentWindow: true });
    
    for (const tab of allTabs) {
      if (tab.url && tab.url.includes('sandbox.html')) {
        // 找到对应的 tab，发送消息切换到编辑器 tab
        await chrome.tabs.sendMessage(tab.id, { __hfes_open_editor__: true, scriptId, eventId });
        return { ok: true, tabId: tab.id };
      }
    }
    
    // 如果没有打开 sandbox.html，尝试查找 options.html
    for (const tab of allTabs) {
      if (tab.url && tab.url.includes('options.html')) {
        // 在 options 页中打开新 tab（使用 sandbox.html）
        const newTab = await chrome.tabs.create({ 
          url: chrome.runtime.getURL('sandbox.html'),
          active: true
        });
        // 等待 tab 加载完成后发送消息
        await new Promise(resolve => setTimeout(resolve, 500));
        await chrome.tabs.sendMessage(newTab.id, { __hfes_open_editor__: true, scriptId, eventId });
        return { ok: true, tabId: newTab.id };
      }
    }
    
    // 如果还没有任何页面打开，创建新 tab
    const newTab = await chrome.tabs.create({ 
      url: chrome.runtime.getURL('options.html') + `?scriptId=${scriptId}&eventId=${eventId}`,
      active: true
    });
    
    // 等待 options 加载完成，然后在该 tab 中打开 sandbox.html
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 在同一个 tab 中打开 sandbox.html（带参数）
    const sandboxTab = await chrome.tabs.create({ 
      url: chrome.runtime.getURL('sandbox.html') + `?scriptId=${scriptId}&eventId=${eventId}`,
      active: true,
      index: newTab.id
    });
    
    return { ok: true, tabId: sandboxTab.id };
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
  },
  async getDomainRuleGroups() {
    const d = await chrome.storage.local.get(['domainRuleGroups']);
    return Array.isArray(d.domainRuleGroups) ? d.domainRuleGroups : [];
  },
  async saveDomainRuleGroups(data) {
    if (!Array.isArray(data)) throw new Error('Invalid data');
    await chrome.storage.local.set({ domainRuleGroups: data });
    return true;
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
