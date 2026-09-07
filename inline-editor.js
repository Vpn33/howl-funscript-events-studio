// inline-editor.js — Funscript 事件动作编辑器
// 复用 wave-editor-core.js 的 canvas 核心逻辑
(function () {
  'use strict';
  const Core = window.WaveEditorCore;
  
  // 获取 CONFIG（如果存在）
  const CONFIG = Core && Core.CONFIG ? Core.CONFIG : { defaultZoomMin: 10000 };

  // ---- 从 URL hash 读参数 ----
  const params = new URLSearchParams(location.hash.slice(1));
  const SCRIPT_ID = params.get('scriptId') || '';
  const EVENT_ID   = params.get('eventId')   || '';
  if (!SCRIPT_ID || !EVENT_ID) {
    const loading = document.getElementById('loading');
    if (loading) loading.textContent = '参数缺失';
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

  // ---- 时间范围筛选 ----
  let viewRangeMs = CONFIG.defaultZoomMin;  // 默认显示最近 10 秒的数据 (从配置读取)
  let minAt = 0; // 起始时间阈值
  
  // ---- DOM ----
  const canvas = document.getElementById('cv') || null;
  const tbody = document.getElementById('tbody') || null;
  const phInfo = document.getElementById('phInfo') || null;
  const loading = document.getElementById('loading') || null;
  const titleEl = document.getElementById('evTitle') || null;
  const idInput = document.getElementById('evIdInput') || null;
  const titleInput = document.getElementById('evTitleInput') || null;
  const btnPlay = document.getElementById('btnPlay') || null;
  const btnPush = document.getElementById('btnPush') || null;
  const btnCancel = document.getElementById('btnCancel') || null;
  const btnSave = document.getElementById('btnSave') || null;
  const wgShape = document.getElementById('wgShape') || null;
  const wgFromEnd = document.getElementById('wgFromEnd') || null;
  const wgDuration = document.getElementById('wgDuration') || null;
  const wgPeriod = document.getElementById('wgPeriod') || null;
  const wgMin = document.getElementById('wgMin') || null;
  const wgMax = document.getElementById('wgMax') || null;
  const btnAdd = document.getElementById('btnAdd') || null;
  const btnGenWave = document.getElementById('btnGenWave') || null;
  const btnPulse = document.getElementById('btnPulse') || null;
  const pulseFile = document.getElementById('pulseFile') || null;
  const chkAll = document.getElementById('chkAll') || null;
  const btnDelSel = document.getElementById('btnDelSel') || null;
  const btnClear = document.getElementById('btnClear') || null;
  const btnSort = document.getElementById('btnSort') || null;
  const btnLoop = document.getElementById('btnLoop') || null;
  const rangeStart = document.getElementById('rangeStart') || null;
  const rangeEnd = document.getElementById('rangeEnd') || null;
  const btnDelRange = document.getElementById('btnDelRange') || null;

  // ---- 监听数据变化 ----
  let dataWatchers = [];
  function watchData(callback) {
    dataWatchers.push(callback);
  }
  function notifyDataChanged() {
    for (const cb of dataWatchers) cb();
  }

  // 时间范围控制 DOM
  const viewRangeMsInput = document.getElementById('viewRangeMs') || null;
  const btnApplyRange = document.getElementById('btnApplyRange') || null;

  // ---- 数据操作 ----
  function filterActionsByRange(actions, minAt) {
    return actions.filter(a => a.at >= minAt);
  }

  function sortAndRender() {
    Core.normalize(eventData.actions);
    selectedRows.clear();
    renderTable();
    fullDraw();
  }

  function updateViewRange(ms) {
    viewRangeMs = Math.min(ms, eventData.actions.length ? eventData.actions[eventData.actions.length - 1].at : 0);
    const maxAt = eventData.actions.length ? Math.max(...eventData.actions.map(a => a.at)) : 0;
    minAt = Math.max(0, maxAt - viewRangeMs);
    notifyDataChanged();
  }

  // ---- 绘制（更新视图时重绘）----
  function fullDraw() {
    if (!eventData || !canvas) return;
    
    // 使用所有动作数据绘制，但通过 viewRangeMs 控制显示范围
    const ctx = canvas.getContext('2d');
    Core.draw(ctx, canvas, eventData.actions, {
      dragIdx, playing, playheadMs,
      isRightSelecting, selStartX, selStartY, selCurX, selCurY,
      vm: viewRangeMs  // 使用当前可见范围而不是总时长
    });
  }

  let lastDrawTime = 0;
  function throttledDraw() {
    const now = Date.now();
    if (now - lastDrawTime < 50) return; // 节流：每 50ms 最多重绘一次
    lastDrawTime = now;
    fullDraw();
  }

  function updateDeleteSelBtn() {
    const n = selectedRows.size;
    btnDelSel.textContent = '删除选中 (' + n + ')';
    btnDelSel.disabled = n === 0;
  }

  // ---- 表格 ----
  function renderTable() {
    if (!eventData) return;
    
    // 获取当前视图范围内的动作（只显示最近 viewRangeMs 的数据）
    const actionsToShow = eventData.actions.filter(a => a.at >= minAt);
    
    tbody.innerHTML = '';
    const n = actionsToShow.length;
    if (n === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#909399;padding:20px;">暂无动作数据</td></tr>';
      if (chkAll) {
        chkAll.checked = false;
        chkAll.indeterminate = false;
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      const a = actionsToShow[i];
      const originalIdx = eventData.actions.indexOf(a); // 获取原始索引
      const tr = document.createElement('tr');
      const checked = selectedRows.has(originalIdx) ? 'checked' : '';
      tr.innerHTML = `
        <td class="sel-col"><input type="checkbox" data-i="${originalIdx}" ${checked}></td>
        <td style="color:#909399;">${i + 1}</td>
        <td><input type="number" min="0" step="any" value="${a.at}" onchange="inlineEditor.updateActionAt(${originalIdx}, this.value)"></td>
        <td><input type="number" min="0" max="100" step="1" value="${a.pos}" onchange="inlineEditor.updateActionPos(${originalIdx}, this.value)"></td>
        <td><button class="del-link" data-i="${originalIdx}">删除</button></td>
      `;
      const cbs = tr.querySelectorAll('input[type="checkbox"]');
      if (cbs[0]) {
        cbs[0].addEventListener('change', (e) => {
          if (e.target.checked) selectedRows.add(originalIdx); else selectedRows.delete(originalIdx);
          updateDeleteSelBtn();
        });
      }
      const inputs = tr.querySelectorAll('input[type="number"]');
      if (inputs[0]) {
        inputs[0].addEventListener('change', () => {
          eventData.actions[originalIdx].at = Math.max(0, parseInt(inputs[0].value) || 0);
          sortAndRender();
        });
      }
      if (inputs[1]) {
        inputs[1].addEventListener('change', () => {
          eventData.actions[originalIdx].pos = Core.clamp(parseInt(inputs[1].value) || 0, 0, 100);
          sortAndRender();
        });
      }
      const delLink = tr.querySelector('.del-link');
      if (delLink) {
        delLink.addEventListener('click', (e) => {
          const idx = parseInt(e.target.dataset.i);
          eventData.actions.splice(idx, 1);
          // 修正 selectedRows：删除后后面的索引都前移
          const newSet = new Set();
          selectedRows.forEach(j => { if (j < idx) newSet.add(j); else if (j > idx) newSet.add(j - 1); });
          selectedRows.clear();
          newSet.forEach(j => selectedRows.add(j));
          sortAndRender();
        });
      }
      tbody.appendChild(tr);
    }
    
    // 全选 checkbox 状态
    const totalActions = eventData.actions.length;
    if (chkAll) {
      chkAll.checked = n > 0 && selectedRows.size === totalActions;
      chkAll.indeterminate = selectedRows.size > 0 && selectedRows.size < totalActions && n > 0;
    }
    if (btnDelSel) updateDeleteSelBtn();
  }

  // 暴露给全局的作用域，供表格中的 onchange 事件调用
  window.inlineEditor = {
    updateActionAt: function(idx, value) {
      if (idx >= 0 && idx < eventData.actions.length) {
        eventData.actions[idx].at = Math.max(0, parseInt(value) || 0);
        sortAndRender();
      }
    },
    updateActionPos: function(idx, value) {
      if (idx >= 0 && idx < eventData.actions.length) {
        eventData.actions[idx].pos = Core.clamp(parseInt(value) || 0, 0, 100);
        sortAndRender();
      }
    }
  };

  if (chkAll) chkAll.addEventListener('change', () => {
    if (!eventData || !chkAll) return;
    if (chkAll.checked) {
      eventData.actions.forEach((_, i) => selectedRows.add(i));
    } else {
      selectedRows.clear();
    }
    renderTable();
  });

  // ---- canvas 指针事件（自己绑定，持有外部状态）----
  if (canvas) {
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
  }

  // 缩放相关状态（使用全局变量，因为是纯 JS 没有 Vue）
  let lastScale = 1;
  let touchStartDist = 0;
  let touchStartScale = 1;
  let isPinching = false;

  if (canvas) {
    canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        
        console.log('[inline-editor] wheel: ctrlKey:', e.ctrlKey, 'metaKey:', e.metaKey);
        
        // 计算缩放中心点的数据坐标
        const vmBefore = Core.viewMs(eventData.actions);
        const centerMsBefore = (x / rect.width) * vmBefore;
        
        // 滚轮灵敏度：10% 每步（基于 deltaY）
        const zoomFactor = 1.05;
        const scaleDelta = e.deltaY > 0 ? zoomFactor : 1 / zoomFactor;
        
        // 计算新的 viewMs，直接操作当前变量
        const maxAt = eventData.actions.length ? Math.max(...eventData.actions.map(a => a.at)) : 0;
        viewRangeMs *= scaleDelta;
        viewRangeMs = Math.min(viewRangeMs, maxAt);  // 不超过总时长
        
        // 更新 minAt，保持显示从最近的时间开始
        minAt = Math.max(0, maxAt - viewRangeMs);
        
        console.log('[inline-editor] zoom: oldViewRangeMs:', CONFIG.defaultZoomMin, 'scaleDelta:', scaleDelta.toFixed(4), 'newViewRangeMs:', Math.round(viewRangeMs));
        
        renderTable();
        fullDraw();
      }
    });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx1 = touch1.clientX - touch1.clientY;
        const dy1 = touch1.clientX + touch1.clientY;
        const dx2 = touch2.clientX - touch2.clientY;
        const dy2 = touch2.clientX + touch2.clientY;
        touchStartDist = Math.hypot(dx2 - dx1, dy2 - dy1);
        touchStartScale = lastScale;
        e.preventDefault();
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && isPinching) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx1 = touch1.clientX - touch1.clientY;
        const dy1 = touch1.clientX + touch1.clientY;
        const dx2 = touch2.clientX - touch2.clientY;
        const dy2 = touch2.clientX + touch2.clientY;
        const currentDist = Math.hypot(dx2 - dx1, dy2 - dy1);
        
        if (touchStartDist > 5) {
          const scaleRatio = currentDist / touchStartDist;
          lastScale = Math.max(0.1, Math.min(5, touchStartScale * scaleRatio));
          
          // 计算缩放中心点，保持内容居中
          const rect = canvas.getBoundingClientRect();
          const centerX = (touch1.clientX + touch2.clientX) / 2;
          
          const vmBefore = Core.viewMs(eventData.actions);
          const centerMsBefore = ((centerX - rect.left) / rect.width) * vmBefore;
          
          const vmAfter = centerMsBefore / (((centerX - rect.left) / rect.width) * lastScale);
          
          console.log('[inline-editor] touch zoom: lastScale:', lastScale.toFixed(4), 'vmAfter:', Math.round(vmAfter));
          
          renderTable();
          fullDraw();
        }
        e.preventDefault();
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) {
        isPinching = false;
      }
    });
  }

  // ---- 播放（用 core 的 createPlayer）----
  const player = Core.createPlayer({
    getActions: () => eventData.actions,
    getLoop:    () => eventData && !!eventData.loop,
    onTick:     (ms) => { if (phInfo) phInfo.textContent = (ms / 1000).toFixed(2) + 's'; fullDraw(); },
    onEnd:      () => { playing = false; if (btnPlay && phInfo) { btnPlay.textContent = '预览播放'; phInfo.textContent = ''; } fullDraw(); }
  });

  function startPlay() {
    if (!eventData) return;
    playing = true; btnPlay.textContent = '停止';
    player.start(); fullDraw();
  }
  function stopPlay() {
    playing = false; btnPlay.textContent = '预览播放';
    if (phInfo) phInfo.textContent = ''; player.stop(); fullDraw();
  }

  // ---- 按钮 ----
  if (btnPlay) btnPlay.onclick = () => { if (playing) stopPlay(); else startPlay(); };

  // 添加动作
  if (btnAdd) btnAdd.onclick = () => {
    if (!eventData) return;
    const lastAt = eventData.actions.length ? Math.max(...eventData.actions.map(a => a.at || 0)) : 0;
    eventData.actions.push({ at: lastAt + 100, pos: 50 });
    sortAndRender();
  };

  // 清空全部
  if (btnClear) btnClear.onclick = () => {
    if (!eventData || !confirm('确定清空全部动作？')) return;
    eventData.actions = [];
    selectedRows.clear();
    renderTable(); fullDraw();
  };

  // 排序去重
  if (btnSort) btnSort.onclick = () => { if (!eventData) return; sortAndRender(); };

  // 切换循环
  if (btnLoop) btnLoop.onclick = () => {
    if (!eventData) return;
    eventData.loop = !eventData.loop;
    alert('循环：' + (eventData.loop ? '开' : '关'));
  };

  // 删除选中
  if (btnDelSel) btnDelSel.onclick = () => {
    if (!eventData || selectedRows.size === 0) return;
    const idxs = Array.from(selectedRows).sort((a, b) => b - a); // 倒序
    for (const i of idxs) eventData.actions.splice(i, 1);
    selectedRows.clear();
    sortAndRender();
  };

  // 按时间区间删除
  if (btnDelRange) btnDelRange.onclick = () => {
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

  // 时间范围应用按钮
  if (btnApplyRange) btnApplyRange.onclick = () => {
    if (!eventData || !viewRangeMsInput) return;
    const ms = parseInt(viewRangeMsInput.value);
    if (isNaN(ms) || ms < 1000) { alert('请输入至少 1 秒的时间范围'); return; }
    
    // 计算新的起始时间阈值（总时长 - 显示范围）
    const maxAt = eventData.actions.length ? Math.max(...eventData.actions.map(a => a.at)) : 0;
    minAt = Math.max(0, maxAt - ms);
    
    renderTable();
    fullDraw();
    
    // 更新输入框显示
    viewRangeMsInput.value = ms;
  };

  // 实时更新显示范围（当用户调整数据时自动适应）
  watchData(() => {
    if (!eventData || !viewRangeMsInput) return;
    const maxAt = Math.max(...eventData.actions.map(a => a.at));
    const minAtNow = Math.max(0, maxAt - viewRangeMs);
    
    // 只有当 minAt 变化时才更新，避免不必要的重绘
    if (minAt !== minAtNow) {
      minAt = minAtNow;
      renderTable();
      fullDraw();
    }
  });

  // ---- 内置波形生成器 ----
  function initWaveGen() {
    if (wgShape && Core.WAVE_SHAPES) {
      wgShape.innerHTML = Core.WAVE_SHAPES.map(s =>
        `<option value="${s.value}">${s.label}</option>`
      ).join('');
    }
  }
  if (btnGenWave) btnGenWave.onclick = () => {
    if (!eventData) return;
    const shape = wgShape && wgShape.value;
    const duration = (wgDuration && parseInt(wgDuration.value)) || 5000;
    const period = (wgPeriod && parseInt(wgPeriod.value)) || 1000;
    const min = Core.clamp((wgMin && parseInt(wgMin.value)) || 0, 0, 100);
    const max = Core.clamp((wgMax && parseInt(wgMax.value)) || 100, 0, 100);
    let start;
    if (wgFromEnd && wgFromEnd.checked) {
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
  const pulseModal = document.getElementById('pulseModal') || null;
  const pulsePickFile = document.getElementById('pulsePickFile') || null;
  const pulseFile2 = document.getElementById('pulseFile2') || null;
  const pulseBreakFlat = document.getElementById('pulseBreakFlat') || null;
  const pulseVariation = document.getElementById('pulseVariation') || null;
  const pulseText = document.getElementById('pulseText') || null;
  const pulseCancel = document.getElementById('pulseCancel') || null;
  const pulseImport = document.getElementById('pulseImport') || null;

  if (btnPulse) btnPulse.onclick = () => { if (pulseModal) pulseModal.style.display = 'flex'; };
  if (pulseCancel && pulseModal) pulseCancel.onclick = () => { if (pulseModal) pulseModal.style.display = 'none'; };
  if (pulseModal) pulseModal.addEventListener('click', (e) => { if (e.target === pulseModal) pulseModal.style.display = 'none'; });

  if (pulsePickFile && pulseFile2) {
    pulsePickFile.onclick = () => pulseFile2.click();
    pulseFile2.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { if (pulseText) pulseText.value = reader.result; };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  if (pulseImport && pulseModal) {
    pulseImport.onclick = () => {
      if (!eventData) return;
      const content = pulseText && pulseText.value ? pulseText.value.trim() : '';
      if (!content) { alert('请先粘贴或选择 .pulse 文件内容'); return; }
      try {
        let actions = Core.parsePulseToActions(content);
        if (!actions.length) throw new Error('未解析到波形数据');
        if (pulseBreakFlat && pulseBreakFlat.checked) {
          const beforeLen = actions.length;
          actions = Core.postProcessFlatSegments(actions, parseInt(pulseVariation.value) || 0, 3);
          console.log('已打破平段，扰动 ±' + (pulseVariation ? pulseVariation.value : 0) + '，共 ' + beforeLen + ' 点');
        }
        const base = eventData.actions.length
          ? Math.max(...eventData.actions.map(a => a.at || 0))
          : 0;
        eventData.actions.push(...actions.map(a => ({ at: a.at + base, pos: a.pos })));
        sortAndRender();
        if (pulseModal) pulseModal.style.display = 'none';
        if (pulseText) pulseText.value = '';
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
  }

  // ---- 推送到设备（先保存，再推送整个 funscript）----
  if (btnPush) btnPush.onclick = async () => {
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
        title: (titleInput && titleInput.value) || EVENT_ID,
        loop: eventData.loop || false,
        actions: cleaned
      });
      if (!saveResp || !saveResp.ok) { alert('保存失败：' + (saveResp && saveResp.error || '未知')); return; }

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
        alert('推送失败：' + ((r && r.error) || '未知错误'));
      }
    } catch (e) {
      btnPush.disabled = false; btnPush.textContent = '推送到设备';
      alert('推送出错：' + e.message);
    }
  };

  // ---- 取消/保存 ----
  if (btnCancel) btnCancel.onclick = () => {
    if (lastSaved && JSON.stringify(lastSaved) !== JSON.stringify(eventData)) {
      if (!confirm('有未保存的修改，确定放弃？')) return;
    }
    closeSelf();
  };

  if (btnSave) btnSave.onclick = async () => {
    if (!eventData) return;
    Core.normalize(eventData.actions);
    const cleaned = eventData.actions.map(a => ({
      at: Math.max(0, parseInt(a.at) || 0),
      pos: Core.clamp(parseInt(a.pos) || 0, 0, 100)
    }));
    const resp = await chrome.runtime.sendMessage({
      type: 'HFES_UPDATE_SCRIPT_EVENT',
      scriptId: SCRIPT_ID, eventId: EVENT_ID,
      title: (titleInput && titleInput.value) || EVENT_ID,
      loop: eventData.loop || false,
      actions: cleaned
    });
    if (resp && resp.ok) {
      lastSaved = JSON.parse(JSON.stringify(eventData));
      notifyParent('saved');
      closeSelf();
    } else {
      alert('保存失败：' + (resp && resp.error || '未知'));
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

      // 默认显示最近 N 秒的数据（从配置读取）
      viewRangeMs = CONFIG.defaultZoomMin;
      
      if (titleEl) titleEl.textContent = '编辑事件：' + eventData.title;
      if (idInput) idInput.value = eventData.id;
      if (titleInput) {
        titleInput.value = eventData.title;
        titleInput.oninput = () => { eventData.title = titleInput.value; };
      }

      lastSaved = JSON.parse(JSON.stringify(eventData));
      if (loading && loading.parentNode) loading.remove();

      initWaveGen();
      
      // 自动计算并应用初始时间范围
      if (eventData.actions.length > 0) {
        const maxAt = Math.max(...eventData.actions.map(a => a.at));
        minAt = Math.max(0, maxAt - viewRangeMs);
      }
      
      renderTable();
      fullDraw();
    } catch (e) {
      if (loading) loading.textContent = '加载失败：' + e.message;
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (canvas) fullDraw(); }, 80);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && btnCancel) btnCancel.click();
  });

  load();
})();
