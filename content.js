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

  let activeMonitors = [];   // 当前 URL 匹配脚本的监控器列表
  let lastFired = new Map(); // monitorId -> 上次触发时的元素值（同值不重复触发）
  let currentMatchKey = null; // 当前应用的脚本 id（判断是否切换脚本）
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
  function isMatchDetailed(m, v) {
    if (v == null) return { ok: false, error: '未读到值' };
    const expect = m.value || '';
    try {
      switch (m.match) {
        case 'notEquals': return { ok: v !== expect };
        case 'notContains': return { ok: v.indexOf(expect) < 0 };
        case 'startsWith': return { ok: v.startsWith(expect) };
        case 'endsWith': return { ok: v.endsWith(expect) };
        case 'regex':
          if (!expect) return { ok: false, error: '正则为空' };
          return { ok: new RegExp(expect).test(v) };
        case 'contains': return { ok: v.indexOf(expect) >= 0 };
        default: return { ok: v === expect }; // equals
      }
    } catch (e) {
      return { ok: false, error: '正则无效: ' + e.message };
    }
  }

  function isMatch(m, v) {
    const r = isMatchDetailed(m, v);
    return r.ok && !r.error;
  }

  // 「测试」按钮：在当前页面即时验证一条监控器（不真正触发事件）
  function testMonitor(m, resultEl) {
    let v = null;
    if ((m.type || 'dom') === 'url') {
      v = readUrlValue(m);
    } else {
      let els;
      try { els = document.querySelectorAll(m.selector || ''); } catch (e) {
        resultEl.textContent = '✗ 选择器无效: ' + e.message;
        resultEl.className = 'mon-result bad';
        return;
      }
      const elm = els && els[0];
      if (!elm) {
        resultEl.textContent = '✗ 未找到元素: ' + (m.selector || '(选择器为空)');
        resultEl.className = 'mon-result bad';
        return;
      }
      v = readValue(elm, m);
      if (v == null) {
        resultEl.textContent = '✗ 未读到值' + ((m.observe || 'text') === 'attr' ? '（属性 ' + (m.attrName || '?') + ' 不存在）' : '');
        resultEl.className = 'mon-result bad';
        return;
      }
    }
    const r = isMatchDetailed(m, v);
    const preview = v.length > 36 ? v.slice(0, 36) + '…' : v;
    if (r.error) {
      resultEl.textContent = '✗ ' + r.error;
      resultEl.className = 'mon-result bad';
      return;
    }
    if (r.ok) {
      resultEl.textContent = '✓ 匹配，当前值: "' + preview + '" → 将触发 ' + (m.eventId || '(未选事件)');
      resultEl.className = 'mon-result';
    } else {
      resultEl.textContent = '✗ 不匹配，当前值: "' + preview + '"';
      resultEl.className = 'mon-result bad';
    }
  }

  async function triggerEvent(eventId, monitor) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'HFES_TRIGGER_EVENT', eventId });
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
    for (const m of activeMonitors) {
      if (m.enabled === false) continue;
      let v;
      if ((m.type || 'dom') === 'url') {
        v = readUrlValue(m);
      } else {
        let els;
        try { els = document.querySelectorAll(m.selector || ''); } catch { continue; }
        const el = els && els[0];
        if (!el) continue;
        v = readValue(el, m);
      }
      const key = m.id || m.selector + '|' + m.eventId;
      const prev = lastFired.get(key);
      if (isMatch(m, v) && v !== prev) {
        // 值满足条件且与上次触发值不同（含初始状态即满足、以及变化为期望值）
        lastFired.set(key, v);
        triggerEvent(m.eventId, m);
      } else if (!isMatch(m, v) && prev !== undefined) {
        // 值离开匹配状态后重置，允许下次再次进入时触发
        lastFired.delete(key);
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

  function applyMatched(matched) {
    const newKey = matched && matched.id ? matched.id : null;
    if (newKey !== currentMatchKey) {
      // 切换了脚本（或取消匹配）：重置触发状态
      lastFired.clear();
    } else {
      // 同一脚本重新应用（保存配置 / SPA 导航 / 后台重发）：
      // 保留触发状态，避免同一值重复触发；仅清理已不存在的监控器
      const keys = new Set(activeMonitors.map(m => m.id || m.selector + '|' + m.eventId));
      for (const k of Array.from(lastFired.keys())) {
        if (!keys.has(k)) lastFired.delete(k);
      }
    }
    currentMatchKey = newKey;

    stopObserving();
    activeMonitors = matched && Array.isArray(matched.monitors) ? matched.monitors.slice() : [];
    if (activeMonitors.length) {
      startObserving();
      // 初始检查：元素初始状态或当前 URL 即满足条件也触发一次
      setTimeout(() => evaluateMonitors(), 300);
    }
  }

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
  let panelState = { scripts: [], settings: null, url: '', matchedId: null };
  let panelMonitors = []; // 面板内编辑中的监控器（尚未保存）
  let panelScriptId = '';

  const POS_STYLE = {
    left: { top: '0', left: '0', width: '340px', height: '100vh', borderRight: '1px solid #3a3a4a' },
    right: { top: '0', right: '0', width: '340px', height: '100vh', borderLeft: '1px solid #3a3a4a' },
    bottom: { left: '0', bottom: '0', width: '340px', height: '300px', borderTop: '1px solid #3a3a4a' }
  };

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
      .mon .del { background: transparent; border: none; color: #ff6b6b; cursor: pointer; font-size: 15px; }
      .mon .chk { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #a0a0b8; }
      .mon .test { background: #2e6da4; color: #fff; border: none; border-radius: 4px;
                   padding: 4px 14px; cursor: pointer; font-size: 12px; }
      .mon .test:hover { background: #3a7bc0; }
      .mon-result { font-size: 11px; line-height: 1.5; color: #7fd08f; word-break: break-all;
                    margin-left: 6px; }
      .mon-result.bad { color: #ff9090; }
      .mon-result:empty { display: none; }
      .chkline { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #a0a0b8;
                 margin-top: 6px; cursor: pointer; }
      .chkline input { width: auto; accent-color: #7c5cff; cursor: pointer; }
      .sec-head { display: flex; align-items: center; margin-bottom: 6px; }
      .sec-head .add { margin-left: auto; background: #7c3aed; color: #fff; border: none;
                       border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
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

  function monitorCard(m, idx) {
    const card = el('div', 'mon');

    // 启用 + 类型 + 删除
    const isUrl = (m.type || 'dom') === 'url';
    const r0 = el('div', 'row');
    const chk = el('label', 'chk');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = m.enabled !== false;
    cb.onchange = () => { m.enabled = cb.checked; };
    chk.appendChild(cb); chk.appendChild(el('span', null, '启用'));
    r0.appendChild(chk);
    const typeSel = document.createElement('select');
    typeSel.className = 'grow';
    typeSel.innerHTML = '<option value="dom">监控 DOM 元素</option><option value="url">监控页面 URL</option>';
    typeSel.value = isUrl ? 'url' : 'dom';
    typeSel.onchange = () => {
      m.type = typeSel.value;
      m.observe = m.type === 'url' ? 'full' : 'text';
      renderMonitors();
    };
    r0.appendChild(typeSel);
    const del = el('button', 'del', '✕');
    del.title = '删除此监控器';
    del.onclick = () => { panelMonitors.splice(idx, 1); renderMonitors(); };
    r0.appendChild(del);
    card.appendChild(r0);

    if (isUrl) {
      // URL 监控对象：整个 URL / 路径 / 查询参数 / 哈希
      const r2 = el('div', 'row');
      r2.appendChild(el('span', 'lbl', '监控'));
      const obs = document.createElement('select');
      obs.className = 'grow';
      obs.innerHTML =
        '<option value="full">整个 URL</option>' +
        '<option value="path">路径 (pathname)</option>' +
        '<option value="query">查询参数 (?a=)</option>' +
        '<option value="hash">哈希 (#...)</option>';
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
    } else {
      // 选择器
      const r1 = el('div', 'row');
      r1.appendChild(el('span', 'lbl', '选择'));
      const sel = document.createElement('input');
      sel.type = 'text'; sel.value = m.selector || ''; sel.placeholder = 'CSS 选择器，如 .page-num';
      sel.className = 'grow';
      sel.oninput = () => { m.selector = sel.value; };
      r1.appendChild(sel);
      card.appendChild(r1);

      // 监控对象：文本 / 属性
      const r2 = el('div', 'row');
      r2.appendChild(el('span', 'lbl', '监控'));
      const obs = document.createElement('select');
      obs.className = 'grow';
      obs.innerHTML = '<option value="text">元素文本 (text)</option><option value="attr">元素属性 (attr)</option>';
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

    const r3 = el('div', 'row');
    r3.appendChild(el('span', 'lbl', '条件'));
    const mt = document.createElement('select');
    mt.className = 'grow';
    mt.innerHTML =
      '<option value="equals">值等于 (==)</option>' +
      '<option value="notEquals">值不等于 (!=)</option>' +
      '<option value="contains">值包含 (indexOf)</option>' +
      '<option value="notContains">值不包含</option>' +
      '<option value="startsWith">值开头为 (startsWith)</option>' +
      '<option value="endsWith">值结尾为 (endsWith)</option>' +
      '<option value="regex">正则匹配 (RegExp.test)</option>';
    mt.value = m.match || 'equals';
    mt.onchange = () => { m.match = mt.value; };
    r3.appendChild(mt);
    card.appendChild(r3);

    const r4 = el('div', 'row');
    r4.appendChild(el('span', 'lbl', '当值'));
    const val = document.createElement('input');
    val.type = 'text'; val.value = m.value || ''; val.placeholder = '期望值，如 3';
    val.className = 'grow';
    val.oninput = () => { m.value = val.value; };
    r4.appendChild(val);
    card.appendChild(r4);

    // 触发事件 ID
    const r5 = el('div', 'row');
    r5.appendChild(el('span', 'lbl', '触发'));
    const ev = document.createElement('select');
    ev.className = 'grow';
    const script = panelState.scripts.find(s => s.id === panelScriptId);
    const ids = script ? script.eventIds.filter(Boolean) : [];
    let opts = '';
    ids.forEach(id => { opts += `<option value="${escapeHtml(id)}">事件: ${escapeHtml(id)}</option>`; });
    if (m.eventId && !ids.includes(m.eventId)) opts += `<option value="${escapeHtml(m.eventId)}">${escapeHtml(m.eventId)} (不存在)</option>`;
    if (!opts) opts = '<option value="">(该脚本无事件)</option>';
    ev.innerHTML = opts;
    ev.value = m.eventId || (ids.length ? ids[0] : '');
    if (!m.eventId && ids.length) m.eventId = ids[0];
    if (ev.selectedIndex < 0) ev.value = '';
    ev.onchange = () => { m.eventId = ev.value; };
    r5.appendChild(ev);
    card.appendChild(r5);

    // 测试按钮 + 结果行
    const r6 = el('div', 'row');
    r6.appendChild(el('span', 'lbl', ''));
    const testBtn = el('button', 'test', '测试');
    testBtn.type = 'button';
    testBtn.title = '在当前页面即时验证此条件（不会真正触发事件）';
    const result = el('div', 'mon-result');
    testBtn.onclick = () => testMonitor(m, result);
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
    panelMonitors.forEach((m, i) => list.appendChild(monitorCard(m, i)));
    if (!panelMonitors.length) {
      list.appendChild(el('div', 'empty', '暂无监控器，点击「+ 添加」创建'));
    }
  }

  function renderPanel() {
    const root = host.shadowRoot;
    const url = panelState.url;
    const matchedScript = panelState.scripts.find(s => s.id === panelState.matchedId);

    // 关联 URL（可编辑）+ 匹配方式
    root.getElementById('urlInput').value = (matchedScript && matchedScript.url) || url || '';
    root.getElementById('prefixChk').checked = !!(matchedScript && matchedScript.urlMatch === 'prefix');

    // 关联脚本下拉
    const sel = root.getElementById('scriptSel');
    let opts = '<option value="">(不关联)</option>';
    panelState.scripts.forEach(s => {
      const name = s.title || s.filename || s.id;
      opts += `<option value="${escapeHtml(s.id)}">${escapeHtml(name)}${s.url && s.url !== url ? '  [' + escapeHtml(s.url) + ']' : ''}</option>`;
    });
    sel.innerHTML = opts;
    sel.value = panelState.matchedId || '';
    if (sel.selectedIndex < 0) sel.value = '';
    panelScriptId = sel.value;
    sel.onchange = () => { panelScriptId = sel.value; renderMonitors(); };

    // 预填当前匹配脚本的监控器
    panelMonitors = matchedScript ? (matchedScript.monitors || []).map(m => Object.assign({}, m)) : [];
    renderMonitors();

    setPosition(panelState.settings.panelPosition || 'right');
  }

  async function openPanel() {
    const resp = await chrome.runtime.sendMessage({ type: 'HFES_GET_STATE', url: location.href });
    if (!resp || !resp.ok) { console.warn('[HFES] 获取状态失败'); return; }
    panelState = { scripts: resp.scripts, settings: resp.settings, url: location.href, matchedId: resp.matchedId };

    if (!host) {
      // 清理可能残留的旧面板节点（扩展重载前留下的孤儿 DOM）
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
          <span class="title">Funscript 关联</span>
          <span class="pos">
            <button data-pos="left">左</button><button data-pos="right">右</button><button data-pos="bottom">底</button>
          </span>
          <button id="closeBtn">✕</button>
        </div>
        <div class="body">
          <div class="sec">
            <label>关联 URL（可编辑，用于和访问地址匹配）</label>
            <input type="text" id="urlInput" placeholder="留空则使用当前页地址">
            <label class="chkline"><input type="checkbox" id="prefixChk"> 前缀匹配（URL 翻页网站勾选，访问地址以此开头即命中）</label>
          </div>
          <div class="sec"><label>关联脚本</label><select id="scriptSel"></select></div>
          <div class="sec">
            <div class="sec-head"><label style="margin:0;">监控触发器（DOM / URL）</label><button class="add" id="addMon">+ 添加</button></div>
            <div id="monList"></div>
            <div class="hint">监控器分两类：DOM 元素（文本/属性）与 页面 URL（整个地址/路径/查询参数/哈希）。值满足条件且发生变化时，调用对应事件 ID 到 Howl 的 /event 接口（支持 等于/不等于/包含/开头/结尾/正则）。「测试」按钮即时验证当前页面，不会真正触发。保存后立即生效。</div>
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
        if (!panelScriptId) { showToast('请先选择要关联的脚本', true); return; }
        panelMonitors.push({ id: (crypto.randomUUID ? crypto.randomUUID() : 'm' + Date.now()), enabled: true, type: 'dom', selector: '', observe: 'text', match: 'equals', value: '', eventId: '' });
        renderMonitors();
      };
      shadow.querySelectorAll('.pos button').forEach(b => {
        b.onclick = async () => {
          setPosition(b.dataset.pos);
          await chrome.runtime.sendMessage({ type: 'HFES_SAVE_SETTINGS', patch: { panelPosition: b.dataset.pos } });
        };
      });
      shadow.getElementById('saveBtn').onclick = savePanel;
      document.documentElement.appendChild(host);
    }
    // 填充数据并设置面板位置（左侧/右侧/底部）
    renderPanel();
    
    // 设置初始位置和高度
    const panel = host.shadowRoot.querySelector('.panel');
    const savedPos = panelState.settings?.panelPosition || 'right';
    setPosition(savedPos);
  }

  async function savePanel() {
    if (!host) return;
    // 关联 URL 使用面板中编辑后的值（留空回退当前地址）
    const url = host.shadowRoot.getElementById('urlInput').value.trim() || location.href;
    const urlMatch = host.shadowRoot.getElementById('prefixChk').checked ? 'prefix' : 'exact';
    // 1) 保存关联
    const r1 = await chrome.runtime.sendMessage({ type: 'HFES_ASSOCIATE', url, scriptId: panelScriptId, urlMatch });
    if (!r1 || !r1.ok) { showToast('关联保存失败: ' + (r1 && r1.error || ''), true); return; }
    // 2) 保存监控器
    if (panelScriptId) {
      const r2 = await chrome.runtime.sendMessage({ type: 'HFES_SAVE_MONITORS', scriptId: panelScriptId, monitors: panelMonitors });
      if (!r2 || !r2.ok) { showToast('监控器保存失败: ' + (r2 && r2.error || ''), true); return; }
    }
    showToast('已保存并应用');
    // 3) 立即重新评估（触发 status / load_funscript / 应用新监控器）
    await chrome.runtime.sendMessage({ type: 'HFES_REAPPLY', url });
  }

  function closePanel() {
    if (host) { host.remove(); host = null; }
  }

  // ---------------- 消息 ----------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'HFES_APPLY':
        applyMatched(msg.matched);
        // 若面板开着，刷新面板数据
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
