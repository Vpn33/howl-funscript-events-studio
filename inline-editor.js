// inline-editor.js — Funscript 事件动作编辑器
// 复用 wave-editor-core.js 的 canvas 核心逻辑
(function () {
  'use strict';
  const Core = window.WaveEditorCore;

  // ---- 从 URL hash 读参数 ----
  const params = new URLSearchParams(location.hash.slice(1));
  const SCRIPT_ID = params.get('scriptId') || '';
  const EVENT_ID   = params.get('eventId')   || '';
  if (!SCRIPT_ID || !EVENT_ID) {
    document.getElementById('loading').textContent = '参数缺失';
    return;
  }

  // ---- 状态 ----
  let eventData = null; // { id, title, actions, loop }
  let lastSaved = null;
  let playing = false;
  let playheadMs = 0;
  let dragIdx = -1, selStartX = 0, selStartY = 0, selCurX = 0, selCurY = 0;
  let isRightClick = false, isRightSelecting = false;
  const selectedRows = new Set(); // 选中的行索引

  // ---- DOM ----
  const canvas = document.getElementById('cv');
  const tbody = document.getElementById('tbody');
  const phInfo = document.getElementById('phInfo');
  const loading = document.getElementById('loading');
  const titleEl = document.getElementById('evTitle');
  const idInput = document.getElementById('evIdInput');
  const titleInput = document.getElementById('evTitleInput');
  const btnPlay = document.getElementById('btnPlay');
  const btnPush = document.getElementById('btnPush');
  const wgShape = document.getElementById('wgShape');
  const wgFromEnd = document.getElementById('wgFromEnd');
  const wgDuration = document.getElementById('wgDuration');
  const wgPeriod = document.getElementById('wgPeriod');
  const wgMin = document.getElementById('wgMin');
  const wgMax = document.getElementById('wgMax');
  const btnGenWave = document.getElementById('btnGenWave');
  const btnPulse = document.getElementById('btnPulse');
  const pulseFile = document.getElementById('pulseFile');
  const chkAll = document.getElementById('chkAll');
  const btnDelSel = document.getElementById('btnDelSel');
  const btnClear = document.getElementById('btnClear');
  const btnSort = document.getElementById('btnSort');
  const btnLoop = document.getElementById('btnLoop');
  const rangeStart = document.getElementById('rangeStart');
  const rangeEnd = document.getElementById('rangeEnd');
  const btnDelRange = document.getElementById('btnDelRange');

  // ---- 数据操作 ----
  function sortAndRender() {
    Core.normalize(eventData.actions);
    selectedRows.clear();
    renderTable();
    fullDraw();
  }

  // ---- 绘制 ----
  function fullDraw() {
    if (!eventData) return;
    const ctx = canvas.getContext('2d');
    Core.draw(ctx, canvas, eventData.actions, {
      dragIdx, playing, playheadMs,
      isRightSelecting, selStartX, selStartY, selCurX, selCurY,
      vm: Core.viewMs(eventData.actions)
    });
  }

  function updateDeleteSelBtn() {
    const n = selectedRows.size;
    btnDelSel.textContent = '删除选中 (' + n + ')';
    btnDelSel.disabled = n === 0;
  }

  // ---- 表格 ----
  function renderTable() {
    if (!eventData) return;
    tbody.innerHTML = '';
    const n = eventData.actions.length;
    for (let i = 0; i < n; i++) {
      const a = eventData.actions[i];
      const tr = document.createElement('tr');
      const checked = selectedRows.has(i) ? 'checked' : '';
      tr.innerHTML = `
        <td class="sel-col"><input type="checkbox" data-i="${i}" ${checked}></td>
        <td style="color:#909399;">${i + 1}</td>
        <td><input type="number" min="0" step="any" value="${a.at}"></td>
        <td><input type="number" min="0" max="100" step="1" value="${a.pos}"></td>
        <td><button class="del-link" data-i="${i}">删除</button></td>
      `;
      const cbs = tr.querySelectorAll('input[type="checkbox"]');
      cbs[0].addEventListener('change', (e) => {
        if (e.target.checked) selectedRows.add(i); else selectedRows.delete(i);
        updateDeleteSelBtn();
      });
      const inputs = tr.querySelectorAll('input[type="number"]');
      inputs[0].addEventListener('change', () => {
        eventData.actions[i].at = Math.max(0, parseInt(inputs[0].value) || 0);
        sortAndRender();
      });
      inputs[1].addEventListener('change', () => {
        eventData.actions[i].pos = Core.clamp(parseInt(inputs[1].value) || 0, 0, 100);
        sortAndRender();
      });
      tr.querySelector('.del-link').addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.i);
        eventData.actions.splice(idx, 1);
        // 修正 selectedRows
        const newSet = new Set();
        selectedRows.forEach(j => { if (j < idx) newSet.add(j); else if (j > idx) newSet.add(j - 1); });
        selectedRows.clear();
        newSet.forEach(j => selectedRows.add(j));
        sortAndRender();
      });
      tbody.appendChild(tr);
    }
    // 全选 checkbox 状态
    chkAll.checked = n > 0 && selectedRows.size === n;
    chkAll.indeterminate = selectedRows.size > 0 && selectedRows.size < n;
    updateDeleteSelBtn();
  }

  chkAll.addEventListener('change', () => {
    if (!eventData) return;
    if (chkAll.checked) {
      eventData.actions.forEach((_, i) => selectedRows.add(i));
    } else {
      selectedRows.clear();
    }
    renderTable();
  });

  // ---- canvas 指针事件（自己绑定，持有外部状态）----
  canvas.addEventListener('pointerdown', (e) => {
    if (!eventData) return;
    canvas.setPointerCapture(e.pointerId);
    const { x, y, ms, pos } = Core.toData(e, canvas, Core.viewMs(eventData.actions));
    if (e.button === 2) {
      selStartX = selCurX = x; selStartY = selCurY = y;
      isRightClick = true; isRightSelecting = false;
      return;
    }
    const { idx, dist } = Core.nearestPoint(eventData.actions, canvas, x, y, Core.viewMs(eventData.actions));
    if (idx >= 0 && dist <= 12) {
      dragIdx = idx;
    } else {
      eventData.actions.push({ at: Math.round(ms), pos: Math.round(Core.clamp(pos, 0, 100)) });
      Core.normalize(eventData.actions);
      dragIdx = eventData.actions.findIndex(a =>
        Math.abs(a.at - Math.round(ms)) < 1 && Math.abs(a.pos - Math.round(Core.clamp(pos, 0, 100))) < 1
      );
    }
    renderTable();
    fullDraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!eventData) return;
    const { x, y } = Core.toData(e, canvas, Core.viewMs(eventData.actions));
    if (isRightClick) {
      selCurX = x; selCurY = y;
      if (!isRightSelecting && Math.hypot(x - selStartX, y - selStartY) > 5) {
        isRightSelecting = true;
      }
      if (isRightSelecting) fullDraw();
      return;
    }
    if (dragIdx < 0) return;
    const p = eventData.actions[dragIdx]; if (!p) return;
    const { ms, pos } = Core.toData(e, canvas, Core.viewMs(eventData.actions));
    p.at = Math.max(0, Math.round(ms));
    p.pos = Math.round(Core.clamp(pos, 0, 100));
    renderTable();
    fullDraw();
  });

  canvas.addEventListener('pointerup', () => {
    if (!eventData) return;
    if (isRightClick) {
      if (isRightSelecting) {
        const rect = canvas.getBoundingClientRect();
        const xMin = Math.min(selStartX, selCurX), xMax = Math.max(selStartX, selCurX);
        const yMin = Math.min(selStartY, selCurY), yMax = Math.max(selStartY, selCurY);
        const vm = Core.viewMs(eventData.actions);
        const before = eventData.actions.length;
        eventData.actions = eventData.actions.filter(a => {
          const px = a.at / vm * rect.width;
          const py = (1 - a.pos / 100) * rect.height;
          return !(px >= xMin && px <= xMax && py >= yMin && py <= yMax);
        });
        Core.normalize(eventData.actions);
        selectedRows.clear();
        if (before - eventData.actions.length) console.log('框选删除 ' + (before - eventData.actions.length) + ' 个');
      } else {
        const { idx, dist } = Core.nearestPoint(eventData.actions, canvas, selStartX, selStartY, Core.viewMs(eventData.actions));
        if (idx >= 0 && dist <= 12) {
          eventData.actions.splice(idx, 1);
          selectedRows.clear();
        }
      }
      isRightClick = false; isRightSelecting = false;
      renderTable();
      fullDraw();
      return;
    }
    if (dragIdx >= 0) { Core.normalize(eventData.actions); dragIdx = -1; renderTable(); fullDraw(); }
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- 播放（用 core 的 createPlayer）----
  const player = Core.createPlayer({
    getActions: () => eventData.actions,
    getLoop:    () => eventData && !!eventData.loop,
    onTick:     (ms) => { playheadMs = ms; phInfo.textContent = (ms / 1000).toFixed(2) + 's'; fullDraw(); },
    onEnd:      () => { playing = false; btnPlay.textContent = '预览播放'; phInfo.textContent = ''; fullDraw(); }
  });

  function startPlay() {
    if (!eventData) return;
    playing = true; btnPlay.textContent = '停止';
    player.start(); fullDraw();
  }
  function stopPlay() {
    playing = false; btnPlay.textContent = '预览播放';
    phInfo.textContent = ''; player.stop(); fullDraw();
  }

  // ---- 按钮 ----
  btnPlay.onclick = () => { if (playing) stopPlay(); else startPlay(); };

  // 添加动作
  document.getElementById('btnAdd').onclick = () => {
    if (!eventData) return;
    const lastAt = eventData.actions.length ? Math.max(...eventData.actions.map(a => a.at || 0)) : 0;
    eventData.actions.push({ at: lastAt + 100, pos: 50 });
    sortAndRender();
  };

  // 清空全部
  btnClear.onclick = () => {
    if (!eventData || !confirm('确定清空全部动作？')) return;
    eventData.actions = [];
    selectedRows.clear();
    renderTable(); fullDraw();
  };

  // 排序去重
  btnSort.onclick = () => { if (!eventData) return; sortAndRender(); };

  // 切换循环
  btnLoop.onclick = () => {
    if (!eventData) return;
    eventData.loop = !eventData.loop;
    alert('循环: ' + (eventData.loop ? '开' : '关'));
  };

  // 删除选中
  btnDelSel.onclick = () => {
    if (!eventData || selectedRows.size === 0) return;
    const idxs = Array.from(selectedRows).sort((a, b) => b - a); // 倒序
    for (const i of idxs) eventData.actions.splice(i, 1);
    selectedRows.clear();
    sortAndRender();
  };

  // 按时间区间删除
  btnDelRange.onclick = () => {
    if (!eventData) return;
    const s = parseInt(rangeStart.value);
    const e = parseInt(rangeEnd.value);
    if (isNaN(s) || isNaN(e) || s > e) { alert('请输入有效的时间范围'); return; }
    const before = eventData.actions.length;
    eventData.actions = eventData.actions.filter(a => !(a.at >= s && a.at <= e));
    const removed = before - eventData.actions.length;
    if (!removed) { alert('时间范围 ' + s + '~' + e + 'ms 内没有动作'); return; }
    selectedRows.clear();
    sortAndRender();
  };

  // ---- 内置波形生成器 ----
  function initWaveGen() {
    wgShape.innerHTML = Core.WAVE_SHAPES.map(s =>
      `<option value="${s.value}">${s.label}</option>`
    ).join('');
  }
  btnGenWave.onclick = () => {
    if (!eventData) return;
    const shape = wgShape.value;
    const duration = parseInt(wgDuration.value) || 5000;
    const period = parseInt(wgPeriod.value) || 1000;
    const min = Core.clamp(parseInt(wgMin.value) || 0, 0, 100);
    const max = Core.clamp(parseInt(wgMax.value) || 100, 0, 100);
    let start;
    if (wgFromEnd.checked) {
      start = eventData.actions.length
        ? Math.max(...eventData.actions.map(a => a.at || 0))
        : 0;
    } else {
      start = 0;
    }
    const list = Core.generateWave(shape, start, duration, period, min, max);
    if (!list.length) { alert('生成的波形为空，请检查参数'); return; }
    eventData.actions.push(...list.map(a => ({ ...a })));
    sortAndRender();
  };

  // 导入 .pulse — 打开模态框
  const pulseModal = document.getElementById('pulseModal');
  const pulsePickFile = document.getElementById('pulsePickFile');
  const pulseFile2 = document.getElementById('pulseFile2');
  const pulseBreakFlat = document.getElementById('pulseBreakFlat');
  const pulseVariation = document.getElementById('pulseVariation');
  const pulseText = document.getElementById('pulseText');
  const pulseCancel = document.getElementById('pulseCancel');
  const pulseImport = document.getElementById('pulseImport');

  btnPulse.onclick = () => { pulseModal.style.display = 'flex'; };
  pulseCancel.onclick = () => { pulseModal.style.display = 'none'; };
  pulseModal.addEventListener('click', (e) => { if (e.target === pulseModal) pulseModal.style.display = 'none'; });

  pulsePickFile.onclick = () => pulseFile2.click();
  pulseFile2.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { pulseText.value = reader.result; };
    reader.readAsText(file);
    e.target.value = '';
  });

  pulseImport.onclick = () => {
    if (!eventData) return;
    const content = pulseText.value.trim();
    if (!content) { alert('请先粘贴或选择 .pulse 文件内容'); return; }
    try {
      let actions = Core.parsePulseToActions(content);
      if (!actions.length) throw new Error('未解析到波形数据');
      if (pulseBreakFlat.checked) {
        const beforeLen = actions.length;
        actions = Core.postProcessFlatSegments(actions, parseInt(pulseVariation.value) || 0, 3);
        console.log('已打破平段，扰动 ±' + pulseVariation.value + '，共 ' + beforeLen + ' 点');
      }
      const base = eventData.actions.length
        ? Math.max(...eventData.actions.map(a => a.at || 0))
        : 0;
      eventData.actions.push(...actions.map(a => ({ at: a.at + base, pos: a.pos })));
      sortAndRender();
      pulseModal.style.display = 'none';
      pulseText.value = '';
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };

  // ---- 推送到设备（先保存，再推送整个 funscript）----
  btnPush.onclick = async () => {
    if (!eventData) return;
    try {
      // 1. 先保存当前事件修改
      Core.normalize(eventData.actions);
      const cleaned = eventData.actions.map(a => ({
        at: Math.max(0, parseInt(a.at) || 0),
        pos: Core.clamp(parseInt(a.pos) || 0, 0, 100)
      }));
      const saveResp = await chrome.runtime.sendMessage({
        type: 'HFES_UPDATE_SCRIPT_EVENT',
        scriptId: SCRIPT_ID, eventId: EVENT_ID,
        title: titleInput.value || EVENT_ID,
        loop: eventData.loop || false,
        actions: cleaned
      });
      if (!saveResp || !saveResp.ok) { alert('保存失败: ' + (saveResp && saveResp.error || '未知')); return; }

      // 2. 拉取完整 funscript
      const fsResp = await chrome.runtime.sendMessage({ type: 'HFES_GET_SCRIPT_FUNSCRIPT', scriptId: SCRIPT_ID });
      if (!fsResp || !fsResp.ok) { alert('读取脚本失败'); return; }
      const fs = fsResp.funscript;

      // 3. 推送设备
      btnPush.disabled = true; btnPush.textContent = '推送中…';
      const r = await chrome.runtime.sendMessage({
        type: 'HFES_PUSH_FUNSCRIPT',
        title: (fs && fs.metadata && fs.metadata.title) || 'Events Script',
        loop: false,
        play: false,
        funscript: fs
      });
      btnPush.disabled = false; btnPush.textContent = '推送到设备';
      if (r && r.ok) {
        alert('推送成功!');
        lastSaved = JSON.parse(JSON.stringify(eventData));
      } else {
        alert('推送失败: ' + ((r && r.error) || '未知错误'));
      }
    } catch (e) {
      btnPush.disabled = false; btnPush.textContent = '推送到设备';
      alert('推送出错: ' + e.message);
    }
  };

  // ---- 取消/保存 ----
  document.getElementById('btnCancel').onclick = () => {
    if (lastSaved && JSON.stringify(lastSaved) !== JSON.stringify(eventData)) {
      if (!confirm('有未保存的修改，确定放弃？')) return;
    }
    closeSelf();
  };

  document.getElementById('btnSave').onclick = async () => {
    if (!eventData) return;
    Core.normalize(eventData.actions);
    const cleaned = eventData.actions.map(a => ({
      at: Math.max(0, parseInt(a.at) || 0),
      pos: Core.clamp(parseInt(a.pos) || 0, 0, 100)
    }));
    const resp = await chrome.runtime.sendMessage({
      type: 'HFES_UPDATE_SCRIPT_EVENT',
      scriptId: SCRIPT_ID, eventId: EVENT_ID,
      title: titleInput.value || EVENT_ID,
      loop: eventData.loop || false,
      actions: cleaned
    });
    if (resp && resp.ok) {
      lastSaved = JSON.parse(JSON.stringify(eventData));
      notifyParent('saved');
      closeSelf();
    } else {
      alert('保存失败: ' + (resp && resp.error || '未知'));
    }
  };

  function closeSelf() {
    try { window.parent.postMessage({ __hfes_inline_editor__: true, action: 'close' }, '*'); } catch (e) {}
    try { window.close(); } catch (e) {}
  }
  function notifyParent(action) {
    try {
      window.parent.postMessage({ __hfes_inline_editor__: true, action, scriptId: SCRIPT_ID, eventId: EVENT_ID }, '*');
    } catch (e) {}
  }

  // ---- 加载 ----
  async function load() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'HFES_GET_SCRIPT_FUNSCRIPT', scriptId: SCRIPT_ID });
      if (!resp || !resp.ok) throw new Error(resp && resp.error || 'background 无响应');
      const funscript = resp.funscript || { events: [] };
      let ev = (funscript.events || []).find(e => e.id === EVENT_ID);
      eventData = ev
        ? { id: ev.id, title: (ev.metadata && ev.metadata.title) || ev.title || ev.id,
            loop: (ev.metadata ? !!ev.metadata.loop : !!ev.loop),
            actions: JSON.parse(JSON.stringify(ev.actions || [])) }
        : { id: EVENT_ID, title: EVENT_ID, actions: [], loop: false };

      titleEl.textContent = '编辑事件：' + EVENT_ID;
      idInput.value = eventData.id;
      titleInput.value = eventData.title;
      titleInput.oninput = () => { eventData.title = titleInput.value; };

      lastSaved = JSON.parse(JSON.stringify(eventData));
      loading.remove();

      initWaveGen();
      renderTable();
      fullDraw();
    } catch (e) {
      loading.textContent = '加载失败: ' + e.message;
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fullDraw, 80);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.getElementById('btnCancel').click();
  });

  load();
})();
