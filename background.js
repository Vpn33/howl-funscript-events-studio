// howl-funscript-events-studio - background service worker
// 职责：右键菜单、URL 监听与匹配、Howl API 调用(status/load_funscript/event)、数据消息路由

const DEFAULT_SETTINGS = {
  host: 'http://127.0.0.1:9080',
  apiKey: '',
  panelPosition: 'right' // left | right | bottom
};

// ---------------- Storage ----------------

async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function getScripts() {
  const data = await chrome.storage.local.get('scripts');
  return Array.isArray(data.scripts) ? data.scripts : [];
}

async function saveScripts(scripts) {
  await chrome.storage.local.set({ scripts });
}

// ================= 域名规则组 =================

async function getDomainRuleGroups() {
  const data = await chrome.storage.local.get('domainRuleGroups');
  return Array.isArray(data.domainRuleGroups) ? data.domainRuleGroups : [];
}

async function saveDomainRuleGroups(groups) {
  if (!Array.isArray(groups)) throw new Error('Invalid domainRuleGroups');
  await chrome.storage.local.set({ domainRuleGroups: groups });
}

// URL 匹配域名规则组（支持通配符）
function findDomainRuleGroupByDomain(ruleGroups, domain) {
  for (const r of ruleGroups) {
    if (!r.enabled || !r.domain || typeof r.domain !== 'string') continue;
    try {
      const pattern = '^' + r.domain.replace(/[.+?^${}()|[\\]\\\\]/g, '\\\\$&').replace(/\*/g, '.*') + '$';
      if (new RegExp(pattern).test(domain)) {
        return r;
      }
    } catch (e) {
      console.warn('[HFES] 域名规则组正则错误:', e.message);
    }
  }
  return null;
}

function findScriptByUrl(scripts, url) {
  if (!url) return null;
  // 先精确匹配
  const exact = scripts.find(s => s.url && s.url === url);
  if (exact) return exact;
  // 前缀匹配（urlMatch === 'prefix'，用于 URL 翻页网站）：最长相邻前缀优先
  let best = null;
  for (const s of scripts) {
    if (s.url && s.urlMatch === 'prefix' && url.startsWith(s.url)) {
      if (!best || s.url.length > best.url.length) best = s;
    }
  }
  return best;
}

// ---------------- Howl API ----------------

async function howlApi(path, body) {
  const settings = await getSettings();
  if (!settings.host) throw new Error('未配置 Howl 设备地址（右键图标 → Settings）');
  const base = settings.host.replace(/\/+$/, '');
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + (settings.apiKey || ''),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body === undefined ? {} : body)
  });
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, body: json };
}

function apiErrorMessage(result) {
  const err = result.body && result.body.error && result.body.error.message;
  return `(${result.status}) ${err || result.statusText || '请求失败'}`;
}

// ---------------- URL 匹配与自动加载 ----------------

// 同一 URL 短时间内的重复评估节流（onUpdated 与 content ready 都会触发）
const lastApplied = new Map(); // tabId -> { url, ts }

function shouldSkip(tabId, url) {
  const rec = lastApplied.get(tabId);
  if (rec && rec.url === url && Date.now() - rec.ts < 1500) return true;
  lastApplied.set(tabId, { url, ts: Date.now() });
  return false;
}

async function evaluateTab(tabId, url, force) {
  if (!url || !/^https?:/i.test(url)) return;
  if (!force && shouldSkip(tabId, url)) {
    console.log('[HFES] 跳过评估（已匹配且未变化）', { tabId, url });
    return;
  }

  let hostname;
  try { hostname = new URL(url).hostname; } catch { hostname = ''; }

  const [scripts, settings, allRuleGroups] = await Promise.all([
    getScripts(),
    getSettings(),
    getDomainRuleGroups()
  ]);

  // ===== 1) 域名优先：匹配域名规则组，拿其 monitors（只含 selector/observe，不含条件/eventId） =====
  const matchedGroup = findDomainRuleGroupByDomain(allRuleGroups, hostname);
  const monitors = matchedGroup && matchedGroup.enabled
    ? (matchedGroup.monitors || []).filter(m => m.enabled !== false)
    : [];

  // ===== 2) URL 匹配：找到关联脚本，load_funscript + 取其 triggers =====
  const matchedScript = findScriptByUrl(scripts, url);

  if (matchedScript) {
    chrome.action.setBadgeText({ tabId, text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' });

    try {
      console.log('[HFES] 调用 /status (tabId=%d)', tabId);
      const st = await howlApi('/status');
      if (st.ok) {
        let playerTitle = (st.body && st.body.player && st.body.player.title) || '';
        const hashIdx = playerTitle.indexOf(' # ');
        if (hashIdx > -1) playerTitle = playerTitle.substring(0, hashIdx);

        const scriptTitle = (matchedScript.funscript && matchedScript.funscript.metadata && matchedScript.funscript.metadata.title) || '';
        if (playerTitle !== scriptTitle) {
          console.log('[HFES] load_funscript（title 不匹配）', { tabId, scriptTitle });
          await howlApi('/load_funscript', {
            title: scriptTitle || 'Events Script',
            loop: false,
            play: false,
            funscript: JSON.stringify(matchedScript.funscript)
          });
        } else {
          console.log('[HFES] 跳过 load_funscript（title 一致）', { tabId });
        }
      }
    } catch (e) {
      console.warn('[HFES] status/load_funscript 异常:', e.message);
    }
  } else {
    chrome.action.setBadgeText({ tabId, text: '' });
  }

  // ===== 3) 触发器：来自匹配脚本的 triggers[]（引用 monitorId + match/value/eventId） =====
  const triggers = matchedScript ? (matchedScript.triggers || []).filter(t => t.enabled !== false) : [];

  console.log('[HFES] evaluateTab 结果', {
    tabId, url, hostname,
    domainGroup: matchedGroup ? matchedGroup.name : null,
    scriptTitle: matchedScript ? (matchedScript.funscript?.metadata?.title || matchedScript.filename) : null,
    monitors: monitors.length,
    triggers: triggers.length
  });

  // ===== 4) 推送给内容脚本（monitors 和 triggers 分开） =====
  chrome.tabs.sendMessage(tabId, {
    type: 'HFES_APPLY',
    domainRule: matchedGroup ? { id: matchedGroup.id, name: matchedGroup.name, domain: matchedGroup.domain, monitors: matchedGroup.monitors || [] } : null,
    matchedScript: matchedScript ? {
      id: matchedScript.id,
      title: (matchedScript.funscript && matchedScript.funscript.metadata && matchedScript.funscript.metadata.title) || '',
      triggers: matchedScript.triggers || [],
      eventIds: ((matchedScript.funscript && matchedScript.funscript.events) || []).map(ev => ev.id || '').filter(Boolean)
    } : null,
    monitors,
    triggers,
    settings: { panelPosition: settings.panelPosition }
  }).catch(() => { /* 页面不支持内容脚本时忽略 */ });
}

// ---------------- 右键菜单 ----------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'hfes-settings', title: 'Settings', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'hfes-associate', title: '关联', contexts: ['action'] });
  });

  // 安装/重载扩展后，向所有已打开的网页重新注入内容脚本
  // （否则旧页面里的内容脚本已成为孤儿，右键关联/监控器全部失效）
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      for (const t of tabs) {
        if (t.id == null) continue;
        chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => { });
      }
    } catch (e) {
      console.warn('[HFES] 重新注入内容脚本失败:', e.message);
    }
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'hfes-settings') {
    chrome.runtime.openOptionsPage();
  } else if (info.menuItemId === 'hfes-associate') {
    chrome.tabs.sendMessage(tab.id, {
      type: 'HFES_TOGGLE_PANEL',
      position: (info && info._position) || null
    }).catch(() => {
      // 内容脚本未注入（如 chrome:// 页面），尝试注入后再打开
      if (/^https?:/i.test(tab.url || '')) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
          .then(() => chrome.tabs.sendMessage(tab.id, { type: 'HFES_TOGGLE_PANEL', position: null }))
          .catch(() => console.warn('[HFES] 该页面无法注入内容脚本'));
      }
    });
  }
});

// ---------------- URL 监听 ----------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    evaluateTab(tabId, (changeInfo.url || (tab && tab.url) || '').toString());
  }
});

chrome.tabs.onRemoved.addListener(tabId => lastApplied.delete(tabId));

// 内容脚本就绪：主动评估当前 URL（覆盖扩展刚安装/页面早于监听器加载的情况）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        // content加载完毕后会调用这里进行地址匹配和脚本推送
        case 'HFES_CONTENT_READY': {
          const tabId = sender.tab && sender.tab.id;
          if (tabId != null) evaluateTab(tabId, msg.url || (sender.tab && sender.tab.url) || '');
          sendResponse({ ok: true });
          break;
        }

        case 'HFES_REAPPLY': {
          // 保存关联/监控器后立即重新评估当前标签页（跳过节流）
          const tabId = sender.tab && sender.tab.id;
          if (tabId != null) evaluateTab(tabId, msg.url || (sender.tab && sender.tab.url) || '', true);
          sendResponse({ ok: true });
          break;
        }

        case 'HFES_GET_STATE': {
          const [settings, scripts] = await Promise.all([getSettings(), getScripts()]);
          const url = msg.url || '';
          const matched = findScriptByUrl(scripts, url);
          sendResponse({
            ok: true,
            settings,
            scripts: scripts.map(s => ({
              id: s.id,
              filename: s.filename || '',
              url: s.url || '',
              urlMatch: s.urlMatch === 'prefix' ? 'prefix' : 'exact',
              title: (s.funscript && s.funscript.metadata && s.funscript.metadata.title) || '',
              eventIds: ((s.funscript && s.funscript.events) || []).map(ev => ev.id || ''),
              triggers: s.triggers || []
            })),
            matchedId: matched ? matched.id : null
          });
          break;
        }

        case 'HFES_ASSOCIATE': {
          // 将脚本与 URL 关联（精确 或 前缀；同 URL 唯一，其他脚本的同名关联会被清除）
          const scripts = await getScripts();
          if (!msg.url) { sendResponse({ ok: false, error: 'URL 不能为空' }); break; }
          if (msg.scriptId) {
            const target = scripts.find(s => s.id === msg.scriptId);
            if (!target) { sendResponse({ ok: false, error: '脚本不存在' }); break; }
            scripts.forEach(s => { if (s.url && s.url === msg.url) { s.url = ''; s.urlMatch = 'exact'; } });
            target.url = msg.url;
            target.urlMatch = msg.urlMatch === 'prefix' ? 'prefix' : 'exact';
          } else {
            // 清除该 URL 的所有关联
            scripts.forEach(s => { if (s.url && s.url === msg.url) { s.url = ''; s.urlMatch = 'exact'; } });
          }
          await saveScripts(scripts);
          sendResponse({ ok: true });
          break;
        }

        case 'HFES_SAVE_TRIGGERS': {
          const scripts = await getScripts();
          const target = scripts.find(s => s.id === msg.scriptId);
          if (!target) { sendResponse({ ok: false, error: '脚本不存在' }); break; }
          target.triggers = Array.isArray(msg.triggers) ? msg.triggers : [];
          await saveScripts(scripts);
          sendResponse({ ok: true });
          break;
        }

        case 'HFES_GET_SCRIPT_FUNSCRIPT': {
          const scripts = await getScripts();
          const target = scripts.find(s => s.id === msg.scriptId);
          if (!target) { sendResponse({ ok: false, error: '脚本不存在' }); break; }
          sendResponse({ ok: true, funscript: target.funscript || { events: [] } });
          break;
        }

        case 'HFES_UPDATE_SCRIPT_EVENT': {
          const scripts = await getScripts();
          const target = scripts.find(s => s.id === msg.scriptId);
          if (!target) { sendResponse({ ok: false, error: '脚本不存在' }); break; }
          if (!target.funscript) target.funscript = { events: [] };
          if (!Array.isArray(target.funscript.events)) target.funscript.events = [];
          // 找到或新建该 eventId 对应的事件
          let ev = target.funscript.events.find(e => e.id === msg.eventId);
          if (!ev) {
            ev = { id: msg.eventId, title: msg.title || msg.label || msg.eventId,
                   metadata: { title: msg.title || msg.label || msg.eventId },
                   actions: [] };
            target.funscript.events.push(ev);
          }
          // 覆盖 actions（保留其他字段）
          ev.actions = Array.isArray(msg.actions) ? msg.actions : [];
          // 标题/名称：同时写 metadata.title（Funscript 规范）和顶层 title（兼容内部存储）
          if (msg.title != null) {
            ev.title = msg.title;
            if (ev.metadata) ev.metadata.title = msg.title;
          }
          if (msg.loop != null) {
            ev.loop = msg.loop;
            if (ev.metadata) ev.metadata.loop = !!msg.loop;
          }
          await saveScripts(scripts);
          sendResponse({ ok: true });
          break;
        }

        case 'HFES_SAVE_DOMAIN_RULE_MONITORS': {
          const groups = await getDomainRuleGroups();
          const target = groups.find(g => g.id === msg.ruleGroupId);
          if (!target) { sendResponse({ ok: false, error: '域名规则组不存在' }); break; }
          target.monitors = Array.isArray(msg.monitors) ? msg.monitors : [];
          await saveDomainRuleGroups(groups);
          sendResponse({ ok: true });
          break;
        }

        case 'HFES_TRIGGER_EVENT': {
          try {
            const r = await howlApi('/event', { id: msg.eventId });
            if (r.ok) sendResponse({ ok: true, body: r.body });
            else sendResponse({ ok: false, error: apiErrorMessage(r) });
          } catch (e) {
            sendResponse({ ok: false, error: '网络错误: ' + e.message });
          }
          break;
        }

        case 'HFES_TEST_CONNECTION': {
          try {
            const r = await howlApi('/status');
            if (r.ok) sendResponse({ ok: true, body: r.body });
            else sendResponse({ ok: false, error: apiErrorMessage(r) });
          } catch (e) {
            sendResponse({ ok: false, error: '网络错误: ' + e.message });
          }
          break;
        }

        case 'HFES_PUSH_FUNSCRIPT': {
          // 编辑器「推送到设备」
          try {
            const r = await howlApi('/load_funscript', {
              title: msg.title || 'Events Script',
              loop: !!msg.loop,
              play: !!msg.play,
              funscript: typeof msg.funscript === 'string' ? msg.funscript : JSON.stringify(msg.funscript)
            });
            if (r.ok) sendResponse({ ok: true, body: r.body });
            else sendResponse({ ok: false, error: apiErrorMessage(r) });
          } catch (e) {
            sendResponse({ ok: false, error: '网络错误: ' + e.message });
          }
          break;
        }

        case 'HFES_SAVE_SETTINGS': {
          const next = await saveSettings(msg.patch || {});
          sendResponse({ ok: true, settings: next });
          break;
        }

        case 'HFES_OPEN_OPTIONS': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }

        // HFES_GET_DOMAIN_RULES：获取指定 URL 匹配的域名规则组监控器
        case 'HFES_GET_DOMAIN_RULES': {
          const url = msg.url || (sender.tab && sender.tab.url) || '';
          let hostname = '';
          try { hostname = url ? new URL(url).hostname : ''; } catch {}
          const groups = await getDomainRuleGroups();
          const matched = findDomainRuleGroupByDomain(groups, hostname);
          sendResponse(matched ? (matched.monitors || []) : []);
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // 异步 sendResponse
});
