// howl-funscript-events-studio - content script
// 职责：1) 按 URL 匹配的监控器监听 DOM 变化并触发 Howl 事件
//       2) 「关联」面板（左/右/底部可切换，Shadow DOM 隔离样式）

(() => {
  // 防止同一次注入重复注册监听；扩展重载后旧脚本的上下文已失效（孤儿），
  // 此时 chrome.runtime.getManifest() 会抛错，需要继续向下执行重新注册
  if (window.__HFES_LOADED__) {
    try { chrome.runtime.getManifest(); return; } catch (e) { /* 孤儿脚本，继续重新注入 */ }
  }
  window.__HFES_LOADED__ = true;

  // ---------------- DOM 监控 ----------------

  let activeMonitors = [];   // 当前生效的监控器（只含 selector/observe，来自域名规则组）
  let activeTriggers = [];   // 当前生效的触发器（monitorId + match/value/eventId，来自匹配脚本）
  let matchedScriptCache = null; // 缓存整个 matchedScript 对象（包含 events 数组）
  let lastValues = new Map(); // monitorId -> 上次读到的值（值变化时重新判断 triggers）
  let currentMatchKey = null; // 当前匹配 key（domainGroupId + scriptId 组合）
  let mo = null;
  let evalTimer = null;

  function readValue(el, m) {
    if (!el) return null;
    if (m.observe === 'attr') return m.attrName ? el.getAttribute(m.attrName) : null;
    return (el.textContent || '').trim();
  }

  // URL 监控器：从当前地址提取值
  // observe: full(整个URL) / path(路径) / query(查询参数, 参数名存 attrName) / hash(哈希)
  function readUrlValue(m) {
    try {
      switch (m.observe) {
        case 'path': return location.pathname;
        case 'hash': return location.hash;
        case 'query': {
          if (!m.attrName) return '';
          const u = new URL(location.href);
          const v = u.searchParams.get(m.attrName);
          return v == null ? '' : v;
        }
        default: return location.href; // full
      }
    } catch (e) {
      return location.href;
    }
  }

  // 条件判定（带错误详情，供「测试」按钮展示）
  // equals/notEquals/contains/notContains/startsWith/endsWith/regex
  // 多值：value 可用换行或竖线 | 分隔多个期望值；
  //   正向条件（equals/contains/startsWith/endsWith）任一命中即匹配；
  //   反向条件（notEquals/notContains）全部不命中才匹配；
  //   regex 不拆分（竖线在正则中本身就是 or）。
  function isMatchDetailed(m, v) {
    if (v == null) return { ok: false, error: '未读到值' };
    const raw = m.value || '';
    if (m.match === 'regex') {
      if (!raw) return { ok: false, error: '正则为空' };
      try { return { ok: new RegExp(raw).test(v) }; }
      catch (e) { return { ok: false, error: '正则无效: ' + e.message }; }
    }
    const expects = raw.split(/[\n|]/).map(s => s.trim()).filter(Boolean);
    if (!expects.length) return { ok: false, error: '匹配值为空' };
    const testOne = (expect) => {
      switch (m.match) {
        case 'notEquals': return v !== expect;
        case 'notContains': return v.indexOf(expect) < 0;
        case 'startsWith': return v.startsWith(expect);
        case 'endsWith': return v.endsWith(expect);
        case 'contains': return v.indexOf(expect) >= 0;
        default: return v === expect; // equals
      }
    };
    // 反向条件：所有期望值都不满足才算匹配；正向条件：任一满足即匹配
    const negative = m.match === 'notEquals' || m.match === 'notContains';
    return { ok: negative ? expects.every(testOne) : expects.some(testOne) };
  }

  function isMatch(m, v) {
    const r = isMatchDetailed(m, v);
    return r.ok && !r.error;
  }

  // 「测试」按钮：支持两种模式
  //   testMonitor(monitor, resultEl)  — 只读取当前值（monitor 无条件）
  //   testMonitor(monitor, trigger, resultEl) — 读取值 + 按 trigger 的条件判断
  function testMonitor() {
    const args = arguments;
    const resultEl = args[args.length - 1];
    const monitor = args[0];
    const trigger = args.length >= 3 ? args[1] : null;

    let v = null;
    if ((monitor.type || 'dom') === 'url') {
      v = readUrlValue(monitor);
    } else {
      let els;
      try { els = document.querySelectorAll(monitor.selector || ''); } catch (e) {
        resultEl.textContent = '✗ 选择器无效: ' + e.message;
        resultEl.className = 'mon-result bad';
        return;
      }
      const elm = els && els[0];
      if (!elm) {
        resultEl.textContent = '✗ 未找到元素: ' + (monitor.selector || '(选择器为空)');
        resultEl.className = 'mon-result bad';
        return;
      }
      v = readValue(elm, monitor);
      if (v == null) {
        resultEl.textContent = '✗ 未读到值' + ((monitor.observe || 'text') === 'attr' ? '（属性 ' + (monitor.attrName || '?') + ' 不存在）' : '');
        resultEl.className = 'mon-result bad';
        return;
      }
    }
    const preview = v.length > 36 ? v.slice(0, 36) + '…' : v;

    if (!trigger) {
      // 只读值模式
      resultEl.textContent = '当前值: "' + preview + '"';
      resultEl.className = 'mon-result';
      return;
    }
    // trigger 条件匹配模式
    const r = isMatchDetailed(trigger, v);
    if (r.error) {
      resultEl.textContent = '✗ ' + r.error;
      resultEl.className = 'mon-result bad';
    } else if (r.ok) {
      resultEl.textContent = '✓ 匹配! 值: "' + preview + '" → 触发 ' + (trigger.eventId || '(未选事件)');
      resultEl.className = 'mon-result';
    } else {
      resultEl.textContent = '✗ 不匹配，当前值: "' + preview + '"';
      resultEl.className = 'mon-result bad';
    }
  }

  async function triggerEvent(eventId, monitor) {
    try {
      const msg = { type: 'HFES_TRIGGER_EVENT', eventId };
      const metadata = matchedScriptCache?.events?.find(ev => ev.id === eventId)?.metadata || {};
      if (Object.keys(metadata).length) {
        msg.metadata = metadata;
      }
      const resp = await chrome.runtime.sendMessage(msg);
      if (resp && resp.ok) {
        console.info(`[HFES] 事件已触发: ${eventId} (monitor: ${monitor.selector})`);
      } else {
        const err = resp && resp.error ? resp.error : '无响应';
        console.warn(`[HFES] 事件触发失败: ${eventId} - ${err}`);
        showToast(`事件 ${eventId} 触发失败: ${err}`, true);
      }
    } catch (e) {
      console.warn('[HFES] 事件触发异常:', e.message);
    }
  }

  function evaluateMonitors() {
    for (const monitor of activeMonitors) {
      if (monitor.enabled === false) continue;
      let v;
      if ((monitor.type || 'dom') === 'url') {
        v = readUrlValue(monitor);
      } else {
        let els;
        try { els = document.querySelectorAll(monitor.selector || ''); } catch { continue; }
        const el = els && els[0];
        if (!el) continue;
        v = readValue(el, monitor);
      }
      const prev = lastValues.get(monitor.id);
      if (v != null && v !== prev) {
        lastValues.set(monitor.id, v);
        // 同一监控器可能有多个触发器同时命中（例如通用正则 (\d)+/ 与精确正则 1/），
        // 遍历收集所有命中项，只触发列表中最后一个（最新定义的），
        // 避免通用规则与精确规则无序重复触发同一/不同事件。
        let lastMatched = null;
        for (const trigger of activeTriggers) {
          if (trigger.enabled === false) continue;
          if (trigger.monitorId !== monitor.id) continue;
          if (isMatch(trigger, v)) lastMatched = trigger;
        }
        if (lastMatched) triggerEvent(lastMatched.eventId, monitor);
      } else if (prev !== undefined && v == null) {
        // 元素消失 / URL 读不到值 → 重置，以便下次出现时重新判断
        lastValues.delete(monitor.id);
      }
    }
  }

  function startObserving() {
    stopObserving();
    mo = new MutationObserver(() => {
      clearTimeout(evalTimer);
      evalTimer = setTimeout(() => evaluateMonitors(false), 120);
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true
    });
  }

  function stopObserving() {
    if (mo) { mo.disconnect(); mo = null; }
    clearTimeout(evalTimer);
  }

  function applyMatched(msg) {
    // msg = { domainRule, matchedScript, monitors, triggers, settings }
    const newKey = (msg && msg.domainRule ? 'D:' + msg.domainRule.id : '') +
                   (msg && msg.matchedScript ? 'S:' + msg.matchedScript.id : '');
    if (newKey !== currentMatchKey) {
      // 切换了域名规则组或脚本 → 清空所有状态
      lastValues.clear();
    } else {
      // 同规则同脚本重新应用 → 清理已删除 monitor 的残留值
      const validIds = new Set((msg && msg.monitors || []).map(m => m.id));
      for (const k of Array.from(lastValues.keys())) {
        if (!validIds.has(k)) lastValues.delete(k);
      }
    }
    currentMatchKey = newKey;

    stopObserving();

    activeMonitors = msg && Array.isArray(msg.monitors)
      ? msg.monitors.filter(m => m.enabled !== false)
      : [];
    activeTriggers = msg && Array.isArray(msg.triggers)
      ? msg.triggers.filter(t => t.enabled !== false)
      : [];

    // 缓存整个 matchedScript 对象（包含 events 数组，触发时直接查找）
    if (msg && msg.matchedScript) {
      matchedScriptCache = msg.matchedScript;
    }

    // 缓存供面板读取
    lastDomainRule = msg && msg.domainRule ? msg.domainRule : null;
    lastMatchedScript = msg && msg.matchedScript ? msg.matchedScript : null;

    if (activeMonitors.length) {
      startObserving();
      setTimeout(() => evaluateMonitors(), 300);
    }
  }

  let lastDomainRule = null;
  let lastMatchedScript = null;

  // ---------------- URL 变化监听（SPA 翻页 / hash 路由） ----------------
  // 内容脚本隔离环境 patch history 无法拦截页面调用，采用轻量轮询（300ms 字符串比对）
  let lastKnownUrl = location.href;
  let urlNotifyTimer = null;
  setInterval(() => {
    if (location.href === lastKnownUrl) return;
    lastKnownUrl = location.href;
    // URL 变化：本地立即评估 URL 监控器，并通知后台重新评估（status / load_funscript / 应用）
    clearTimeout(urlNotifyTimer);
    urlNotifyTimer = setTimeout(() => {
      evaluateMonitors();
      chrome.runtime.sendMessage({ type: 'HFES_REAPPLY', url: location.href }).catch(() => {});
    }, 250);
  }, 300);

  // ---------------- 关联面板 ----------------

  let host = null;
  let panelState = { scripts: [], settings: null, url: '' };
  let panelMonitors = [];   // 编辑中的监控器（只含 selector/observe）
  let panelTriggers = [];   // 编辑中的触发器（monitorId + match/value/eventId）
  let panelScriptId = '';
  let panelDomainGroupId = '';
  let panelDomainGroupName = '';
  let panelDomainMatched = false;

  function panelCss() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
      .panel { position: fixed; z-index: 2147483646; background: #1e1e28; color: #dcdce4;
               display: flex; flex-direction: column; font-size: 13px;
               box-shadow: 0 4px 24px rgba(0,0,0,.45); }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
              background: #26262f; border-bottom: 1px solid #3a3a4a; }
      .head .title { font-weight: 600; color: #b79bff; }
      .head .pos { display: flex; gap: 4px; margin-left: auto; }
      .head button { background: #33333f; color: #dcdce4; border: 1px solid #444452;
                     border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
      .head button:hover { background: #44445a; }
      .head button.active { background: #7c3aed; border-color: #7c3aed; color: #fff; }
      /* 位置类 */
      .panel.left { position: fixed !important; top: 0 !important; left: 0 !important; right: auto !important; width: 340px !important; height: 100vh !important; border-right: 1px solid #3a3a4a !important; }
      .panel.right { position: fixed !important; top: 0 !important; right: 0 !important; left: auto !important; width: 340px !important; height: 100vh !important; border-left: 1px solid #3a3a4a !important; }
      .panel.bottom { position: fixed !important; top: auto !important; bottom: 0 !important; left: auto !important; right: 0 !important; width: 340px !important; height: 300px !important; border-left: 1px solid #3a3a4a !important; border-top: 1px solid #3a3a4a !important; }
      .body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }
      .sec label { display: block; font-size: 12px; color: #8f8fa3; margin-bottom: 4px; }
      .url { font-size: 11px; color: #7fb0ff; word-break: break-all; background: #26262f;
             padding: 6px 8px; border-radius: 4px; }
      select, input[type=text] { width: 100%; background: #2a2a36; color: #dcdce4; border: 1px solid #444452;
             border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none; }
      select:focus, input:focus { border-color: #7c3aed; }
      .mon { background: #26262f; border: 1px solid #3a3a4a; border-radius: 6px; padding: 10px; margin-bottom: 8px; }
      .mon .row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
      .mon .row:last-child { margin-bottom: 0; }
      .mon .grow { flex: 1; }
      .mon .lbl { font-size: 11px; color: #8f8fa3; min-width: 34px; }
      .mon .del-btn { background: transparent; border: 1px solid #ff6b6b55; color: #ff9090; border-radius: 4px;
                     cursor: pointer; font-size: 12px; padding: 1px 10px; margin-left: auto; }
      .mon .del-btn:hover { background: #ff6b6b22; border-color: #ff9090; color: #ffb0b0; }
      .edit-ev-btn { background: #3b82f622; border: 1px solid #3b82f666; color: #93c5fd; border-radius: 4px;
                     cursor: pointer; font-size: 12px; padding: 1px 8px; white-space: nowrap; }
      .edit-ev-btn:hover { background: #3b82f644; color: #bfdbfe; }
      .mon .chk { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #a0a0b8; }
      .mon .test { background: #2e6da4; color: #fff; border: none; border-radius: 4px;
                   padding: 4px 14px; cursor: pointer; font-size: 12px; }
      .mon .test:hover { background: #3a7bc0; }
      .mon-result { font-size: 11px; line-height: 1.5; color: #7fd08f; word-break: break-all;
                    margin-left: 6px; }
      .mon-result.bad { color: #ff9090; }
      .mon-result:empty { display: none; }
      .mon-readonly { background: #1e1e28; border: 1px dashed #3a3a4a; opacity: 0.85; }
      .chkline { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #a0a0b8;
                 margin-top: 6px; cursor: pointer; }
      .chkline input { width: auto; accent-color: #7c5cff; cursor: pointer; }
      .sec-head { display: flex; align-items: center; margin-bottom: 6px; }
      .add { background: #7c3aed; color: #fff; border: none;
             border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
      .add:hover { background: #6d28d9; }
      .sec-head .add { margin-left: auto; }
      .add-block { width: 100%; margin-top: 8px; padding: 8px; font-size: 13px; }
      .hint { font-size: 11px; color: #6d6d80; margin-top: 4px; line-height: 1.5; }
      .foot { padding: 10px 12px; border-top: 1px solid #3a3a4a; display: flex; gap: 8px; }
      .foot button { flex: 1; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
      .foot .save { background: #22a06b; color: #fff; font-weight: 600; }
      .foot .save:hover { background: #1d8a5c; }
      #toast { position: absolute; left: 50%; transform: translateX(-50%); bottom: 64px;
               background: #33334a; color: #fff; padding: 8px 14px; border-radius: 6px;
               font-size: 12px; opacity: 0; transition: opacity .25s; pointer-events: none;
               max-width: 80%; text-align: center; }
      #toast.show { opacity: 1; }
      #toast.err { background: #a03a3a; }
      .empty { color: #6d6d80; font-size: 12px; }
    `;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showToast(msg, isErr) {
    if (!host) return;
    const t = host.shadowRoot.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.className = ''; }, 2600);
  }

  function setPosition(pos) {
    if (!host) return;
    const panel = host.shadowRoot.querySelector('.panel');
    // 移除所有位置类，添加新的位置类（用 !important 确保优先级）
    ['left', 'right', 'bottom'].forEach(c => panel.classList.remove(c));
    panel.classList.add(pos);
    host.shadowRoot.querySelectorAll('.pos button').forEach(b =>
      b.classList.toggle('active', b.dataset.pos === pos));
    panelState.settings = Object.assign({}, panelState.settings, { panelPosition: pos });
  }

  function monitorCard(m, idx, readonly) {
    const card = el('div', 'mon');
    const isUrl = (m.type || 'dom') === 'url';

    // 启用 + 类型 + 删除（只读时隐藏删除按钮）
    const r0 = el('div', 'row');
    const chk = el('label', 'chk');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = m.enabled !== false;
    cb.onchange = () => { m.enabled = cb.checked; };
    chk.appendChild(cb); chk.appendChild(el('span', null, '启用'));
    r0.appendChild(chk);
    if (readonly) {
      const typeLabel = el('span', 'grow', isUrl ? '页面 URL' : 'DOM 元素');
      typeLabel.style.color = '#909399';
      typeLabel.style.fontSize = '12px';
      r0.appendChild(typeLabel);
    } else {
      const typeSel = document.createElement('select');
      typeSel.className = 'grow';
      typeSel.innerHTML = '<option value="dom">DOM 元素</option><option value="url">页面 URL</option>';
      typeSel.value = isUrl ? 'url' : 'dom';
      typeSel.onchange = () => {
        m.type = typeSel.value;
        m.observe = m.type === 'url' ? 'full' : 'text';
        renderMonitors();
      };
      r0.appendChild(typeSel);
      const del = el('button', 'del-btn', '删除');
      del.title = '删除此监控器';
      del.onclick = () => {
        panelMonitors.splice(idx, 1);
        panelTriggers = panelTriggers.filter(t => t.monitorId !== m.id);
        renderMonitors();
        renderTriggers();
      };
      r0.appendChild(del);
    }
    card.appendChild(r0);

    if (isUrl) {
      if (readonly) {
        const r2 = el('div', 'row');
        r2.appendChild(el('span', 'lbl', '监控'));
        const obsMap = { full: '整个 URL', path: '路径', query: '查询参数', hash: '哈希' };
        r2.appendChild(el('span', 'grow', obsMap[m.observe] || m.observe || 'full'));
        card.appendChild(r2);
        if ((m.observe || 'full') === 'query') {
          const r2b = el('div', 'row');
          r2b.appendChild(el('span', 'lbl', '参数名'));
          r2b.appendChild(el('span', 'grow', m.attrName || ''));
          card.appendChild(r2b);
        }
      } else {
        const r2 = el('div', 'row');
        r2.appendChild(el('span', 'lbl', '监控'));
        const obs = document.createElement('select');
        obs.className = 'grow';
        obs.innerHTML =
          '<option value="full">整个 URL</option>' +
          '<option value="path">路径</option>' +
          '<option value="query">查询参数</option>' +
          '<option value="hash">哈希</option>';
        obs.value = m.observe || 'full';
        obs.onchange = () => { m.observe = obs.value; renderMonitors(); };
        r2.appendChild(obs);
        card.appendChild(r2);
        if ((m.observe || 'full') === 'query') {
          const r2b = el('div', 'row');
          r2b.appendChild(el('span', 'lbl', '参数名'));
          const attr = document.createElement('input');
          attr.type = 'text'; attr.value = m.attrName || ''; attr.placeholder = '如 page / id';
          attr.className = 'grow';
          attr.oninput = () => { m.attrName = attr.value; };
          r2b.appendChild(attr);
          card.appendChild(r2b);
        }
      }
    } else {
      if (readonly) {
        const r1 = el('div', 'row');
        r1.appendChild(el('span', 'lbl', '选择'));
        const selSpan = el('span', 'grow', m.selector || '');
        selSpan.style.fontFamily = 'monospace';
        selSpan.style.fontSize = '11px';
        selSpan.style.color = '#909399';
        r1.appendChild(selSpan);
        card.appendChild(r1);
        const r2 = el('div', 'row');
        r2.appendChild(el('span', 'lbl', '监控'));
        const obsMap = { text: '元素文本', attr: '元素属性' };
        r2.appendChild(el('span', 'grow', obsMap[m.observe] || m.observe || 'text'));
        card.appendChild(r2);
        if ((m.observe || 'text') === 'attr') {
          const r2b = el('div', 'row');
          r2b.appendChild(el('span', 'lbl', '属性名'));
          r2b.appendChild(el('span', 'grow', m.attrName || ''));
          card.appendChild(r2b);
        }
      } else {
        const r1 = el('div', 'row');
        r1.appendChild(el('span', 'lbl', '选择'));
        const sel = document.createElement('input');
        sel.type = 'text'; sel.value = m.selector || ''; sel.placeholder = 'CSS 选择器，如 .page-header span';
        sel.className = 'grow';
        sel.oninput = () => { m.selector = sel.value; };
        r1.appendChild(sel);
        card.appendChild(r1);

        const r2 = el('div', 'row');
        r2.appendChild(el('span', 'lbl', '监控'));
        const obs = document.createElement('select');
        obs.className = 'grow';
        obs.innerHTML = '<option value="text">元素文本</option><option value="attr">元素属性</option>';
        obs.value = m.observe || 'text';
        obs.onchange = () => { m.observe = obs.value; renderMonitors(); };
        r2.appendChild(obs);
        card.appendChild(r2);
        if ((m.observe || 'text') === 'attr') {
          const r2b = el('div', 'row');
          r2b.appendChild(el('span', 'lbl', '属性名'));
          const attr = document.createElement('input');
          attr.type = 'text'; attr.value = m.attrName || ''; attr.placeholder = '如 data-page / href';
          attr.className = 'grow';
          attr.oninput = () => { m.attrName = attr.value; };
          r2b.appendChild(attr);
          card.appendChild(r2b);
        }
      }
    }

    // 测试按钮（两种模式都保留）
    const r6 = el('div', 'row');
    r6.appendChild(el('span', 'lbl', ''));
    const testBtn = el('button', 'test', '读取当前值');
    testBtn.type = 'button';
    const result = el('div', 'mon-result');
    testBtn.onclick = () => testMonitor(m, result);
    r6.appendChild(testBtn);
    r6.appendChild(result);
    result.classList.add('grow');
    card.appendChild(r6);

    if (readonly) card.classList.add('mon-readonly');
    return card;
  }

  function triggerCard(t, idx) {
    const card = el('div', 'mon');

    // 启用 + 删除（删除靠右）
    const r0 = el('div', 'row');
    const chk = el('label', 'chk');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = t.enabled !== false;
    cb.onchange = () => { t.enabled = cb.checked; };
    chk.appendChild(cb); chk.appendChild(el('span', null, '启用'));
    r0.appendChild(chk);
    // 空占位把后面的删除按钮推到最右
    const spacer = document.createElement('span');
    spacer.className = 'grow';
    r0.appendChild(spacer);
    const del = el('button', 'del-btn', '删除');
    del.title = '删除此触发器';
    del.onclick = () => { panelTriggers.splice(idx, 1); renderTriggers(); };
    r0.appendChild(del);
    card.appendChild(r0);

    // 引用哪个 monitor（panelMonitors 为空时 fallback 到 activeMonitors）
    const r1 = el('div', 'row');
    r1.appendChild(el('span', 'lbl', '来源'));
    const monSel = document.createElement('select');
    monSel.className = 'grow';
    const monitorSrc = panelMonitors.length ? panelMonitors : activeMonitors;
    console.log('[HFES] triggerCard monitor source:', monitorSrc.length, monitorSrc.map(m => m.id), 'chosen:', t.monitorId);
    let mopts = '<option value="">(选择监控器)</option>';
    monitorSrc.forEach(m => {
      const label = (m.type || 'dom') === 'url'
        ? `URL · ${m.observe}${m.attrName ? '(' + m.attrName + ')' : ''}`
        : `DOM · ${(m.selector || '(空)').slice(0, 30)}`;
      mopts += `<option value="${escapeHtml(m.id)}">${escapeHtml(label)}</option>`;
    });
    monSel.innerHTML = mopts;
    monSel.value = t.monitorId || '';
    monSel.onchange = () => { t.monitorId = monSel.value; };
    r1.appendChild(monSel);
    card.appendChild(r1);

    // 条件
    const r3 = el('div', 'row');
    r3.appendChild(el('span', 'lbl', '条件'));
    const mt = document.createElement('select');
    mt.className = 'grow';
    mt.innerHTML =
      '<option value="equals">值等于 (==)</option>' +
      '<option value="notEquals">值不等于 (!=)</option>' +
      '<option value="contains">值包含</option>' +
      '<option value="notContains">值不包含</option>' +
      '<option value="startsWith">值开头为</option>' +
      '<option value="endsWith">值结尾为</option>' +
      '<option value="regex">正则匹配</option>';
    mt.value = t.match || 'equals';
    mt.onchange = () => { t.match = mt.value; };
    r3.appendChild(mt);
    card.appendChild(r3);

    // 当值
    const r4 = el('div', 'row');
    r4.appendChild(el('span', 'lbl', '当值'));
    const val = document.createElement('input');
    val.type = 'text'; val.value = t.value || ''; val.placeholder = '期望值，多个用 | 分隔';
    val.className = 'grow';
    val.title = '多个期望值可用竖线 | 或换行分隔，任一匹配即触发（正则模式下 | 为正则 or）';
    val.oninput = () => { t.value = val.value; };
    r4.appendChild(val);
    card.appendChild(r4);

    // 触发事件 ID + 编辑按钮
    const r5 = el('div', 'row');
    r5.appendChild(el('span', 'lbl', '触发'));
    const ev = document.createElement('select');
    ev.className = 'grow';
    const script = panelState.scripts.find(s => s.id === panelScriptId);
    const ids = script ? script.eventIds.filter(Boolean) : [];
    let eopts = '';
    ids.forEach(id => { eopts += `<option value="${escapeHtml(id)}">事件: ${escapeHtml(id)}</option>`; });
    if (t.eventId && !ids.includes(t.eventId)) eopts += `<option value="${escapeHtml(t.eventId)}">${escapeHtml(t.eventId)} (旧)</option>`;
    if (!eopts) eopts = '<option value="">(该脚本无事件)</option>';
    ev.innerHTML = eopts;
    ev.value = t.eventId || '';
    if (ev.selectedIndex < 0) ev.value = '';
    ev.onchange = () => { t.eventId = ev.value; };
    r5.appendChild(ev);
    // 编辑事件按钮
    const editEvBtn = el('button', 'edit-ev-btn', '编辑事件');
    editEvBtn.title = '在面板中直接编辑此事件的动作';
    editEvBtn.style.marginLeft = '6px';
    editEvBtn.onclick = () => {
      if (!panelScriptId || !t.eventId) { alert('请先选择脚本和事件'); return; }
      openEventEditor(panelScriptId, t.eventId, host.shadowRoot);
    };
    r5.appendChild(editEvBtn);
    // 新增事件按钮：为当前脚本创建空事件并选中
    const addEvBtn = el('button', 'edit-ev-btn', '+事件');
    addEvBtn.title = '为当前脚本新增一个空事件，并选中为该触发器的事件';
    addEvBtn.style.marginLeft = '6px';
    addEvBtn.onclick = async () => {
      if (!panelScriptId) { alert('当前页面未关联脚本，请先在设置中关联'); return; }
      const id = (prompt('新事件 ID（如 page3）：') || '').trim();
      if (!id) return;
      let title = prompt('事件名称（标题，可留空）：', id);
      if (title === null) title = id;
      title = title.trim() || id;
      const resp = await chrome.runtime.sendMessage({ type: 'HFES_ADD_EVENT', scriptId: panelScriptId, eventId: id, title });
      if (!resp || !resp.ok) { alert('添加失败：' + ((resp && resp.error) || '未知错误')); return; }
      // 更新本地缓存，让所有事件下拉立即可见新 ID
      const sc = panelState.scripts.find(s => s.id === panelScriptId);
      if (sc) {
        if (!Array.isArray(sc.eventIds)) sc.eventIds = [];
        if (!sc.eventIds.includes(id)) sc.eventIds.push(id);
      }
      t.eventId = id;
      renderTriggers();
      showToast('已添加事件 ' + id);
    };
    r5.appendChild(addEvBtn);
    card.appendChild(r5);

    // 测试按钮（条件匹配模式）
    const r6 = el('div', 'row');
    r6.appendChild(el('span', 'lbl', ''));
    const testBtn = el('button', 'test', '测试');
    testBtn.type = 'button';
    testBtn.title = '即时验证此触发器（不会真正触发事件）';
    const result = el('div', 'mon-result');
    testBtn.onclick = () => {
      const mon = panelMonitors.find(m => m.id === t.monitorId);
      if (!mon) {
        result.textContent = '✗ 请先选择一个监控器';
        result.className = 'mon-result bad';
        return;
      }
      testMonitor(mon, t, result);
    };
    r6.appendChild(testBtn);
    r6.appendChild(result);
    result.classList.add('grow');
    card.appendChild(r6);

    return card;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderMonitors() {
    if (!host) return;
    const list = host.shadowRoot.getElementById('monList');
    list.innerHTML = '';
    const readonly = panelDomainMatched;
    panelMonitors.forEach((m, i) => list.appendChild(monitorCard(m, i, readonly)));
    if (!panelMonitors.length) {
      list.appendChild(el('div', 'empty', '暂无监控器' + (panelDomainMatched ? '' : '，点击「+ 添加」创建')));
    }
    // 控制「+ 添加」按钮：域名匹配时隐藏（monitor 来自规则组）
    const addBtn = host.shadowRoot.getElementById('addMon');
    if (addBtn) addBtn.style.display = readonly ? 'none' : '';
    renderTriggers();
  }

  // ---- 事件编辑器弹窗（iframe 加载 inline-editor.html）----
  function openEventEditor(scriptId, eventId, sr) {
    const bg = el('div', 'ev-editor-bg');
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483646;' +
                       'display:flex;align-items:center;justify-content:center;';
    const box = el('div', null, '');
    box.style.cssText = 'width:min(1000px,96vw);height:min(720px,90vh);' +
                        'background:white;border-radius:10px;overflow:hidden;' +
                        'box-shadow:0 12px 40px rgba(0,0,0,0.6);display:flex;flex-direction:column;';
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('inline-editor.html') + `#scriptId=${encodeURIComponent(scriptId)}&eventId=${encodeURIComponent(eventId)}`;
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    iframe.title = '编辑事件 ' + eventId;
    box.appendChild(iframe);
    bg.appendChild(box);

    // 监听 iframe 的 postMessage（关闭/保存通知）
    const onMsg = (e) => {
      const d = e.data;
      if (!d || d.__hfes_inline_editor__ !== true) return;
      if (d.action === 'close' || d.action === 'saved') {
        bg.remove();
        window.removeEventListener('message', onMsg);
        if (d.action === 'saved') {
          // 刷新面板里的 trigger 下拉（以防新增了事件）
          renderTriggers();
        }
      }
    };
    window.addEventListener('message', onMsg);

    // 点背景关闭
    bg.addEventListener('click', (e) => {
      if (e.target === bg) { bg.remove(); window.removeEventListener('message', onMsg); }
    });

    // ESC 关闭
    const onKey = (e) => {
      if (e.key === 'Escape') { bg.remove(); window.removeEventListener('message', onMsg); window.removeEventListener('keydown', onKey); }
    };
    window.addEventListener('keydown', onKey);

    sr.appendChild(bg);
  }

  function renderTriggers() {
    if (!host) return;
    const list = host.shadowRoot.getElementById('trigList');
    if (!list) return;
    list.innerHTML = '';
    panelTriggers.forEach((t, i) => list.appendChild(triggerCard(t, i)));
    if (!panelTriggers.length) {
      list.appendChild(el('div', 'empty', '暂无触发器，点击下方「+ 添加触发器」创建'));
    }
  }

  function renderPanel() {
    if (!host) return;
    const root = host.shadowRoot;
    const hostname = location.hostname;

    // ===== 域名匹配状态 =====
    const domainStatus = root.getElementById('domainStatus');
    const domainLink = root.getElementById('domainLink');
    const monSecTitle = root.getElementById('monSecTitle');
    const monSecHint = root.getElementById('monSecHint');
    if (panelDomainMatched) {
      domainStatus.innerHTML = `<span style="color:#7fd08f;">✓ 已匹配: <b>${escapeHtml(panelDomainGroupName)}</b></span>`;
      domainLink.innerHTML = `<button type="button" style="${linkBtnStyle()}">设置页编辑</button>`;
      domainLink.onclick = () => { chrome.runtime.sendMessage({ type: 'HFES_OPEN_OPTIONS' }).catch(() => {}); };
      if (monSecTitle) monSecTitle.innerHTML = '① 监控器 <span style="font-size:10px;color:#909399;font-weight:normal;">(来自规则组 · 只读)</span>';
      if (monSecHint) monSecHint.innerHTML = '监控器定义<strong>观察什么</strong>（CSS 选择器 / URL），已由域名规则组配置，请到设置页修改。条件判断和触发在下方触发器里配置。';
    } else {
      domainStatus.innerHTML = `<span style="color:#ffb973;">⚠ "${escapeHtml(hostname)}" 未匹配域名规则组</span>`;
      domainLink.innerHTML = `<button type="button" style="${linkBtnStyle()}">设置页创建</button>`;
      domainLink.onclick = () => { chrome.runtime.sendMessage({ type: 'HFES_OPEN_OPTIONS' }).catch(() => {}); };
      if (monSecTitle) monSecTitle.innerHTML = '① 监控器（只定义观察目标）';
      if (monSecHint) monSecHint.innerHTML = '当前域名未匹配规则组，可临时添加监控器，或去设置页创建域名规则组（推荐）。';
    }

    // ===== 关联脚本下拉 =====
    const sel = root.getElementById('scriptSel');
    let opts = '<option value="">(选择 funscript)</option>';
    panelState.scripts.forEach(s => {
      const name = s.title || s.filename || s.id;
      opts += `<option value="${escapeHtml(s.id)}">${escapeHtml(name)}${s.url ? '  [URL]' : ''}</option>`;
    });
    sel.innerHTML = opts;
    sel.value = panelScriptId || '';
    if (sel.selectedIndex < 0) sel.value = '';
    const prevScriptId = panelScriptId;
    sel.onchange = () => {
      panelScriptId = sel.value;
      if (prevScriptId !== panelScriptId) renderTriggers();
    };

    // 预填 monitors（来自域名规则组）——双保险：lastDomainRule 或 activeMonitors
    const ruleMonitors = (lastDomainRule && lastDomainRule.monitors) || [];
    const fillMonitors = ruleMonitors.length ? ruleMonitors : activeMonitors;
    if (fillMonitors.length) {
      panelMonitors = fillMonitors.map(m => Object.assign({}, m));
      console.log('[HFES] prefill panelMonitors:', panelMonitors.length, panelMonitors.map(m => m.id));
    } else {
      console.log('[HFES] 无 monitors 可 prefill（lastDomainRule=', !!lastDomainRule, 'activeMonitors=', activeMonitors.length, '）');
    }
    // 预填 triggers（来自匹配脚本）
    const scriptTriggers = (lastMatchedScript && lastMatchedScript.triggers) || [];
    if (scriptTriggers.length) {
      panelTriggers = scriptTriggers.map(t => Object.assign({}, t));
      console.log('[HFES] prefill panelTriggers:', panelTriggers.length);
    }

    renderMonitors();
    setPosition(panelState.settings?.panelPosition || 'right');
  }

  function linkBtnStyle() {
    return 'background: transparent; color: #7c5cff; border: 1px solid #7c5cff; border-radius: 4px; padding: 2px 10px; cursor: pointer; font-size: 11px; text-decoration: none;';
  }

  async function openPanel() {
    // 每次打开面板都清空，确保从 background 推送的最新状态重新加载
    panelMonitors = [];
    panelTriggers = [];

    const resp = await chrome.runtime.sendMessage({ type: 'HFES_GET_STATE', url: location.href });
    if (!resp || !resp.ok) { console.warn('[HFES] 获取状态失败'); return; }
    // 白名单拦截：当前 host 不在监听列表 → 静默退出，不报错
    if (resp.blocked) {
      console.log('[HFES] 当前域名不在监听白名单，跳过');
      if (host) { host.remove(); host = null; }
      return;
    }
    panelState = { scripts: resp.scripts, settings: resp.settings, url: location.href };

    // 使用 background 在最后一次 evaluateTab 时推送过来的缓存信息
    if (lastDomainRule) {
      panelDomainMatched = true;
      panelDomainGroupId = lastDomainRule.id;
      panelDomainGroupName = lastDomainRule.name;
    } else {
      panelDomainMatched = false;
      panelDomainGroupId = '';
      panelDomainGroupName = '';
    }
    if (lastMatchedScript) panelScriptId = lastMatchedScript.id;

    if (!host) {
      const stale = document.getElementById('__hfes_panel_host__');
      if (stale) stale.remove();

      host = document.createElement('div');
      host.id = '__hfes_panel_host__';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = panelCss();
      shadow.appendChild(style);

      const panel = el('div', 'panel');
      panel.innerHTML = `
        <div class="head">
          <span class="title">Funscript 监控面板</span>
          <span class="pos">
            <button data-pos="left">左</button><button data-pos="right">右</button><button data-pos="bottom">底</button>
          </span>
          <button id="closeBtn">✕</button>
        </div>
        <div class="body">
          <div class="sec">
            <label>当前域名</label>
            <div class="url">${escapeHtml(location.hostname)}</div>
            <div style="margin-top:6px;" id="domainStatus"></div>
            <div style="margin-top:4px;" id="domainLink"></div>
          </div>
          <div class="sec">
            <label>关联 funscript（触发器事件来源）</label>
            <select id="scriptSel"></select>
          </div>

          <div class="sec">
            <div class="sec-head">
              <label style="margin:0;" id="monSecTitle">① 监控器（只定义观察目标）</label>
              <button class="add" id="addMon">+ 添加</button>
            </div>
            <div id="monList"></div>
            <div class="hint" id="monSecHint">
              监控器只定义<strong>观察什么</strong>（CSS 选择器 / URL），条件判断和触发在下方触发器里配置。
            </div>
          </div>

          <div class="sec">
            <div class="sec-head">
              <label style="margin:0;">② 触发器（值 + 条件 → 事件）</label>
              <button class="add" id="addTrig">+ 添加触发器</button>
            </div>
            <div id="trigList"></div>
            <button class="add add-block" id="addTrigBottom">+ 添加触发器</button>
            <div class="hint">
              触发器引用上面某个监控器，当<strong>该监控器读到的值变化</strong>时，判断条件是否满足，
              满足则调用 funscript 里对应的事件 ID。<br>
              「当值」可用竖线 | 分隔多个值（任一命中即满足）。同一监控器有多个触发器同时命中时，
              <strong>只触发列表中最下方（最新添加）的那个</strong>，因此请把更精确的规则放在下面。
            </div>
          </div>
        </div>
        <div class="foot">
          <button class="save" id="saveBtn">保存并应用</button>
        </div>
        <div id="toast"></div>
      `;

      shadow.appendChild(panel);

      shadow.getElementById('closeBtn').onclick = closePanel;
      shadow.getElementById('addMon').onclick = () => {
        panelMonitors.push({
          id: (crypto.randomUUID ? crypto.randomUUID() : 'm' + Date.now()),
          enabled: true, type: 'dom', selector: '', observe: 'text', attrName: ''
        });
        renderMonitors();
      };
      const addTrigger = () => {
        // 用上一个触发器做模板（清空 value，eventId 自动设为第一个未占用的）
        const last = panelTriggers[panelTriggers.length - 1];
        const base = last ? { enabled: last.enabled !== false, monitorId: last.monitorId || '', match: last.match || 'equals' }
                          : { enabled: true, monitorId: panelMonitors.length ? panelMonitors[0].id : '', match: 'equals' };
        // 找第一个未被当前 triggers 占用的 eventId
        const script = panelState.scripts.find(s => s.id === panelScriptId);
        const scriptIds = script ? script.eventIds.filter(Boolean) : [];
        const usedIds = new Set(panelTriggers.map(t => t.eventId).filter(Boolean));
        const freeEventId = scriptIds.find(id => !usedIds.has(id)) || scriptIds[0] || '';
        panelTriggers.push({
          id: (crypto.randomUUID ? crypto.randomUUID() : 't' + Date.now()),
          ...base,
          value: '',
          eventId: freeEventId
        });
        renderTriggers();
        // 滚动到新添加的触发器（列表底部按钮直接可见，顶部按钮则滚到最下）
        requestAnimationFrame(() => {
          const list = shadow.getElementById('trigList');
          if (list && list.lastElementChild) list.lastElementChild.scrollIntoView({ block: 'nearest' });
        });
      };
      shadow.getElementById('addTrig').onclick = addTrigger;
      shadow.getElementById('addTrigBottom').onclick = addTrigger;
      shadow.querySelectorAll('.pos button').forEach(b => {
        b.onclick = async () => {
          setPosition(b.dataset.pos);
          await chrome.runtime.sendMessage({ type: 'HFES_SAVE_SETTINGS', patch: { panelPosition: b.dataset.pos } });
        };
      });
      shadow.getElementById('saveBtn').onclick = savePanel;
      document.documentElement.appendChild(host);
    }
    renderPanel();
    setPosition(panelState.settings?.panelPosition || 'right');
  }

  async function savePanel() {
    if (!host) return;
    let ok = true;

    // 域名匹配时 monitor 由设置页统一管理（只读），此处不回存
    // 域名未匹配时没有规则组可存，monitors 也不需要回存
    // monitors 的维护统一在设置页域名规则组里进行

    // 2) 关联脚本 + 保存 triggers（只有选了脚本才有地方存）
    if (panelScriptId && ok) {
      const url = location.href;
      const r1 = await chrome.runtime.sendMessage({
        type: 'HFES_ASSOCIATE', url, scriptId: panelScriptId, urlMatch: 'exact'
      });
      if (!r1 || !r1.ok) { showToast('脚本关联失败: ' + (r1 && r1.error || ''), true); ok = false; }

      // triggers 存脚本
      const r2 = await chrome.runtime.sendMessage({
        type: 'HFES_SAVE_TRIGGERS', scriptId: panelScriptId, triggers: panelTriggers
      });
      if (!r2 || !r2.ok) { showToast('触发器保存失败: ' + (r2 && r2.error || ''), true); ok = false; }
    }

    if (ok) {
      showToast('已保存并应用');
      await chrome.runtime.sendMessage({ type: 'HFES_REAPPLY', url: location.href });
    }
  }

  function closePanel() {
    if (host) { host.remove(); host = null; }
  }

  // ---------------- 消息 ----------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'HFES_APPLY':
        applyMatched(msg);
        if (host) openPanel().catch(e => console.warn('[HFES] 刷新面板失败:', e && e.message));
        sendResponse({ ok: true });
        break;
      case 'HFES_TOGGLE_PANEL':
        if (host) closePanel();
        else openPanel().catch(e => console.warn('[HFES] 打开面板失败:', e && e.message));
        sendResponse({ ok: true });
        break;
    }
  });

  // 就绪通知 background 评估当前 URL（含扩展安装后首次注入）
  chrome.runtime.sendMessage({ type: 'HFES_CONTENT_READY', url: location.href }).catch(() => {});
})();
