// wave-editor-core.js — Funscript 事件波形编辑器纯逻辑核心
// 无框架依赖，无 DOM 依赖，纯函数 + 状态管理
// 被 sandbox.html (options.js) 和 inline-editor.js 共同引用
(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * 排序 + 同 at 去重 + 数值规范化（直接 mutate actions）
   * @param {{at:number,pos:number}[]} actions
   */
  function normalize(actions) {
    if (!Array.isArray(actions)) return;
    actions.sort((a, b) => (a.at || 0) - (b.at || 0));
    const seen = new Set();
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      const k = Math.round(a.at);
      if (seen.has(k)) { actions.splice(i, 1); continue; }
      seen.add(k);
      a.at = Math.max(0, Math.round(a.at));
      a.pos = Math.max(0, Math.min(100, Math.round(a.pos)));
    }
  }

  /**
   * 计算视图时间范围（ms）
   * @param {{at:number,pos:number}[]} actions
   * @returns {number} 至少 5000ms，向上取整到秒
   */
  function viewMs(actions) {
    if (!actions || !actions.length) return 5000;
    const maxAt = Math.max(...actions.map(a => a.at || 0));
    return Math.max(5000, Math.ceil(maxAt / 1000) * 1000);
  }

  /**
   * canvas 像素坐标 → 数据坐标
   * @param {PointerEvent} evt
   * @param {HTMLCanvasElement} canvas
   * @param {number} vm viewMs
   */
  function toData(evt, canvas, vm) {
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    return {
      ms: clamp(x / rect.width, 0, 1) * vm,
      pos: (1 - clamp(y / rect.height, 0, 1)) * 100,
      x, y
    };
  }

  /**
   * 找离 (x,y) 最近的数据点
   * @returns {{idx:number, dist:number}}
   */
  function nearestPoint(actions, canvas, x, y, vm) {
    if (!actions || !actions.length) return { idx: -1, dist: Infinity };
    const rect = canvas.getBoundingClientRect();
    let best = { idx: -1, dist: Infinity };
    actions.forEach((a, i) => {
      const px = a.at / vm * rect.width;
      const py = (1 - a.pos / 100) * rect.height;
      const d = Math.hypot(px - x, py - y);
      if (d < best.dist) best = { idx: i, dist: d };
    });
    return best;
  }

  /**
   * 绘制 canvas
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {{at:number,pos:number}[]} actions
   * @param {object} opts
   *   - dragIdx: number 正在拖拽的索引 (-1 或 >=0)
   *   - playing: boolean 是否正在播放
   *   - playheadMs: number 播放头位置 ms
   *   - isRightSelecting: boolean 右键框选中
   *   - selStartX/Y, selCurX/Y: number 框选坐标（canvas 像素）
   *   - vm: number viewMs (可选，不传则内部计算)
   */
  function draw(ctx, canvas, actions, opts) {
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const vm = opts.vm != null ? opts.vm : viewMs(actions);
    const X = ms => ms / vm * w;
    const Y = pos => (1 - pos / 100) * h;

    // 背景网格
    ctx.strokeStyle = '#e4e7ed';
    ctx.fillStyle = '#909399';
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    const secStep = vm > 60000 ? 10 : (vm > 20000 ? 5 : 1);
    for (let s = 0; s <= vm / 1000; s += secStep) {
      const x = X(s * 1000);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(s + 's', x + 2, h - 4);
    }
    [0, 25, 50, 75, 100].forEach(p => {
      const y = Y(p);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(String(p), 3, y - 3);
    });

    // 波形线
    if (actions && actions.length) {
      ctx.strokeStyle = '#409eff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      actions.forEach((a, i) =>
        i ? ctx.lineTo(X(a.at), Y(a.pos)) : ctx.moveTo(X(a.at), Y(a.pos))
      );
      if (actions.length === 1) ctx.lineTo(X(actions[0].at) + 1, Y(actions[0].pos));
      ctx.stroke();

      // 数据点
      actions.forEach((a, i) => {
        ctx.beginPath();
        ctx.arc(X(a.at), Y(a.pos), i === opts.dragIdx ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === opts.dragIdx ? '#e6a23c' : '#409eff';
        ctx.fill();
      });
    }

    // 播放指针
    if (opts.playing) {
      const x = X(opts.playheadMs || 0);
      ctx.strokeStyle = '#f56c6c';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    // 右键框选
    if (opts.isRightSelecting) {
      const xMin = Math.min(opts.selStartX, opts.selCurX);
      const xMax = Math.max(opts.selStartX, opts.selCurX);
      const yMin = Math.min(opts.selStartY, opts.selCurY);
      const yMax = Math.max(opts.selStartY, opts.selCurY);
      ctx.fillStyle = 'rgba(64,158,255,0.15)';
      ctx.fillRect(xMin, yMin, xMax - xMin, yMax - yMin);
      ctx.strokeStyle = 'rgba(64,158,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(xMin, yMin, xMax - xMin, yMax - yMin);
      ctx.setLineDash([]);
    }
  }

  /**
   * 创建一套指针事件处理器（绑定到 canvas）
   *
   * 用法：
   *   const handlers = WaveEditorCore.createPointerHandlers({
   *     getActions: () => event.actions,      // getter，取当前 actions 数组
   *     getCanvas:  () => canvas,
   *     getViewMs:  () => WaveEditorCore.viewMs(event.actions),
   *     onChange:   () => { normalize(actions); renderTable(); draw(); },
   *     onAfterDelete: () => { clearTableSelection(); }  // 可选
   *   });
   *   canvas.addEventListener('pointerdown', handlers.onPointerDown);
   *   canvas.addEventListener('pointermove', handlers.onPointerMove);
   *   canvas.addEventListener('pointerup',   handlers.onPointerUp);
   *   canvas.addEventListener('contextmenu', handlers.onContextMenu);
   *
   * @returns {{onPointerDown, onPointerMove, onPointerUp, onContextMenu}}
   */
  function createPointerHandlers(cfg) {
    let dragIdx = -1;
    let selStartX = 0, selStartY = 0, selCurX = 0, selCurY = 0;
    let isRightClick = false, isRightSelecting = false;

    function getVm() { return cfg.getViewMs ? cfg.getViewMs() : viewMs(cfg.getActions()); }
    function redraw() { cfg.onChange && cfg.onChange(); }

    const onPointerDown = function (e) {
      const actions = cfg.getActions(); if (!actions) return;
      const canvas = cfg.getCanvas();
      canvas.setPointerCapture(e.pointerId);
      const { x, y, ms, pos } = toData(e, canvas, getVm());
      if (e.button === 2) {
        selStartX = selCurX = x; selStartY = selCurY = y;
        isRightClick = true; isRightSelecting = false;
        return;
      }
      const { idx, dist } = nearestPoint(actions, canvas, x, y, getVm());
      if (idx >= 0 && dist <= 12) {
        dragIdx = idx;
      } else {
        actions.push({ at: Math.round(ms), pos: Math.round(clamp(pos, 0, 100)) });
        normalize(actions);
        dragIdx = actions.findIndex(a =>
          Math.abs(a.at - Math.round(ms)) < 1 &&
          Math.abs(a.pos - Math.round(clamp(pos, 0, 100))) < 1
        );
      }
      redraw();
    };

    const onPointerMove = function (e) {
      const actions = cfg.getActions(); if (!actions) return;
      const canvas = cfg.getCanvas();
      const { x, y } = toData(e, canvas, getVm());
      if (isRightClick) {
        selCurX = x; selCurY = y;
        if (!isRightSelecting && Math.hypot(x - selStartX, y - selStartY) > 5) {
          isRightSelecting = true;
        }
        if (isRightSelecting) redraw();
        return;
      }
      if (dragIdx < 0) return;
      const p = actions[dragIdx]; if (!p) return;
      const { ms, pos } = toData(e, canvas, getVm());
      p.at = Math.max(0, Math.round(ms));
      p.pos = Math.round(clamp(pos, 0, 100));
      redraw();
    };

    const onPointerUp = function () {
      const actions = cfg.getActions();
      const canvas = cfg.getCanvas();
      if (isRightClick) {
        if (isRightSelecting && actions) {
          const rect = canvas.getBoundingClientRect();
          const xMin = Math.min(selStartX, selCurX), xMax = Math.max(selStartX, selCurX);
          const yMin = Math.min(selStartY, selCurY), yMax = Math.max(selStartY, selCurY);
          const before = actions.length;
          const vm = getVm();
          actions = actions.filter(a => {
            const px = a.at / vm * rect.width;
            const py = (1 - a.pos / 100) * rect.height;
            return !(px >= xMin && px <= xMax && py >= yMin && py <= yMax);
          });
          normalize(actions);
          const removed = before - actions.length;
          if (removed) cfg.onAfterDelete && cfg.onAfterDelete(removed);
        } else if (actions) {
          const { idx, dist } = nearestPoint(actions, canvas, selStartX, selStartY, getVm());
          if (idx >= 0 && dist <= 12) actions.splice(idx, 1);
        }
        isRightClick = false; isRightSelecting = false;
        redraw();
        return;
      }
      if (dragIdx >= 0) { normalize(actions); dragIdx = -1; redraw(); }
    };

    const onContextMenu = function (e) { e.preventDefault(); };

    return { onPointerDown, onPointerMove, onPointerUp, onContextMenu };
  }

  // ---- 播放控制（辅助） ----
  /**
   * 播放控制器（简化版，可选使用）
   * 外部需要自己 setInterval/requestAnimationFrame 调 tick()
   */
  function createPlayer({ getActions, getLoop, onTick, onEnd }) {
    let playing = false;
    let playStart = 0;
    let playheadMs = 0;
    let rafId = null;

    function stop() {
      playing = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      playheadMs = 0;
      onTick && onTick(0);
    }
    function start() {
      if (playing) return;
      playing = true;
      playStart = performance.now();
      const tick = (now) => {
        if (!playing) return;
        const vm = viewMs(getActions());
        playheadMs = now - playStart;
        onTick && onTick(playheadMs);
        if (playheadMs >= vm) {
          if (getLoop && getLoop()) { playStart = now; playheadMs = 0; onTick && onTick(0); }
          else { stop(); onEnd && onEnd(); return; }
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }
    return {
      start, stop,
      toggle: () => { if (playing) stop(); else start(); },
      isPlaying: () => playing,
      getPlayhead: () => playheadMs
    };
  }

  // ---------- 内置波形生成器 ----------
  const WAVE_SHAPES = [
    { value: 'sine', label: '正弦波 (Sine)' },
    { value: 'triangle', label: '三角波 (Triangle)' },
    { value: 'sawUp', label: '锯齿上升 (Sawtooth up)' },
    { value: 'sawDown', label: '锯齿下降 (Sawtooth down)' },
    { value: 'square', label: '方波 (Square)' },
    { value: 'heartbeat', label: '心跳 (Heartbeat)' },
    { value: 'gw_fangs', label: '尖牙 (Fangs)' },
    { value: 'gw_curvy_triangle', label: '平滑三角 (Curvy triangle)' },
    { value: 'gw_curvy_fangs', label: '平滑尖牙 (Curvy fangs)' },
    { value: 'gw_curvy_trapezium', label: '平滑梯形 (Curvy trapezium)' },
    { value: 'gw_gentle_attack', label: '缓升 (Gentle attack)' },
    { value: 'gw_fast_attack', label: '快升 (Fast attack)' },
    { value: 'gw_faster_attack', label: '急升 (Faster attack)' },
    { value: 'gw_rising_tide', label: '涨潮 (Rising tide)' },
    { value: 'gw_flourish', label: '华丽 (Flourish)' },
    { value: 'gw_jelly', label: '果冻 (Jelly)' },
    { value: 'gw_tap_slide', label: '点按+滑动 (Tap + slide)' },
    { value: 'gw_double_time', label: '二倍频 (Double time)' },
    { value: 'gw_triple_trouble', label: '三连峰 (Triple trouble)' },
    { value: 'gw_steps', label: '阶梯 (Steps)' }
  ];

  const SMALL_AMT = 0.00001;
  const GEN_WAVE_SHAPES = {
    gw_fangs: { interp: 'LINEAR', points: [
      { t: 0.0, p: 0.0 }, { t: 0.35, p: 1.0 },
      { t: 0.5, p: 0.5 }, { t: 0.65, p: 1.0 } ] },
    gw_curvy_triangle: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.5, p: 1.0, m: 0.0 } ] },
    gw_curvy_fangs: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.35, p: 1.0, m: 0.0 },
      { t: 0.5, p: 0.5, m: 0.0 }, { t: 0.65, p: 1.0, m: 0.0 } ] },
    gw_curvy_trapezium: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.4, p: 0.95, m: 0.1 },
      { t: 0.6, p: 0.95, m: -0.1 } ] },
    gw_gentle_attack: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.75, p: 1.0, m: 0.0 } ] },
    gw_fast_attack: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.25, p: 1.0, m: 0.0 } ] },
    gw_faster_attack: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.15, p: 1.0, m: 0.0 } ] },
    gw_rising_tide: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.1, p: 0.4, m: 0.0 },
      { t: 0.2, p: 0.2, m: 0.0 }, { t: 0.3, p: 0.6, m: 0.0 },
      { t: 0.4, p: 0.4, m: 0.0 }, { t: 0.5, p: 0.8, m: 0.0 },
      { t: 0.6, p: 0.6, m: 0.0 }, { t: 0.7, p: 1.0, m: 0.0 },
      { t: 0.8, p: 0.8, m: 0.0 } ] },
    gw_flourish: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.5, p: 0.8, m: -0.6 },
      { t: 0.66, p: 0.6, m: 0.3 }, { t: 0.86, p: 1.0, m: 0.0 },
      { t: 0.9, p: 1.0, m: 0.0 } ] },
    gw_jelly: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.2, p: 1.0, m: 0.0 },
      { t: 0.3, p: 0.7, m: 0.0 }, { t: 0.4, p: 1.0, m: 0.0 },
      { t: 0.5, p: 0.7, m: 0.0 }, { t: 0.6, p: 1.0, m: 0.0 },
      { t: 0.7, p: 0.7, m: 0.0 }, { t: 0.8, p: 1.0, m: 0.0 } ] },
    gw_tap_slide: { interp: 'LINEAR', points: [
      { t: 0.0, p: 1.0 }, { t: 0.1 - SMALL_AMT, p: 1.0 },
      { t: 0.1, p: 0.0 }, { t: 0.2 - SMALL_AMT, p: 0.0 },
      { t: 0.2, p: 1.0 }, { t: 0.3 - SMALL_AMT, p: 1.0 },
      { t: 0.3, p: 0.0 }, { t: 0.4 - SMALL_AMT, p: 0.0 },
      { t: 0.4, p: 1.0 }, { t: 0.5, p: 1.0 },
      { t: 1.0 - SMALL_AMT, p: 0.0 } ] },
    gw_double_time: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.25, p: 1.0, m: 0.0 },
      { t: 0.5, p: 0.0, m: 0.0 }, { t: 0.625, p: 1.0, m: 0.0 },
      { t: 0.75, p: 0.0, m: 0.0 }, { t: 0.875, p: 1.0, m: 0.0 } ] },
    gw_triple_trouble: { interp: 'HERMITE', points: [
      { t: 0.0, p: 0.0, m: 0.0 }, { t: 0.10, p: 0.98, m: 0.05 },
      { t: 0.14, p: 1.0, m: 0.0 }, { t: 0.28, p: 0.0, m: 0.0 },
      { t: 0.38, p: 0.98, m: 0.05 }, { t: 0.42, p: 1.0, m: 0.0 },
      { t: 0.56, p: 0.0, m: 0.0 }, { t: 0.66, p: 0.98, m: 0.05 },
      { t: 0.70, p: 1.0, m: 0.0 }, { t: 0.84, p: 0.0, m: 0.0 } ] },
    gw_steps: { interp: 'LINEAR', points: [
      { t: 0.0, p: 0.0 }, { t: 0.2 - SMALL_AMT, p: 0.0 },
      { t: 0.2, p: 0.25 }, { t: 0.4 - SMALL_AMT, p: 0.25 },
      { t: 0.4, p: 0.5 }, { t: 0.6 - SMALL_AMT, p: 0.5 },
      { t: 0.6, p: 0.75 }, { t: 0.8 - SMALL_AMT, p: 0.75 },
      { t: 0.8, p: 1.0 }, { t: 1.0 - SMALL_AMT, p: 1.0 } ] }
  };

  function hermite01(t, t0, p0, m0, t1, p1, m1) {
    const dt = t1 - t0;
    if (dt <= 0) return p0;
    const s = (t - t0) / dt;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    return h00 * p0 + h10 * dt * m0 + h01 * p1 + h11 * dt * m1;
  }

  function generateFromShape(shapeDef, periodMs, minPos, maxPos) {
    const P = Math.max(50, Math.round(periodMs));
    const amp = maxPos - minPos;
    const out = [];
    const points = shapeDef.points;
    const interp = shapeDef.interp;
    const n = points.length;
    const STEP_THRESHOLD = 0.001;
    for (let i = 0; i < n; i++) {
      const pt = points[i];
      const ptNext = points[(i + 1) % n];
      const isStep = (i < n - 1) && (ptNext.t - pt.t < STEP_THRESHOLD) && (Math.abs(ptNext.p - pt.p) > 0.01);
      const tMs = Math.round(pt.t * P);
      const posRaw = pt.p * amp + minPos;
      out.push({ at: tMs, pos: Math.round(clamp(posRaw, 0, 100)) });
      if (isStep) {
        const stepT = Math.min(tMs + 1, P);
        const stepPosRaw = ptNext.p * amp + minPos;
        out.push({ at: stepT, pos: Math.round(clamp(stepPosRaw, 0, 100)) });
        i++;
      } else if (interp === 'HERMITE' && i < n - 1) {
        const samples = Math.max(4, Math.round(P / 80));
        const tStart = pt.t * P, tEnd = ptNext.t * P;
        const pos0 = pt.p * amp + minPos, pos1 = ptNext.p * amp + minPos;
        const m0 = pt.m || 0, m1 = ptNext.m || 0;
        const m0Scaled = m0 * amp / P;
        const m1Scaled = m1 * amp / P;
        for (let s = 1; s < samples; s++) {
          const f = s / samples;
          const tAbs = tStart + f * (tEnd - tStart);
          const hRaw = hermite01(f, 0, pos0, m0Scaled, 1, pos1, m1Scaled);
          out.push({ at: Math.round(tAbs), pos: Math.round(clamp(hRaw, 0, 100)) });
        }
      }
    }
    const seen = new Set();
    return out.filter(a => { const k = a.at; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /**
   * 生成波形 actions 数组
   * @param {string} shape 形状名称 ('sine','triangle','sawUp','sawDown','square','heartbeat','gw_*')
   * @param {number} startMs 起始时间 (ms)
   * @param {number} durationMs 持续时间 (ms)
   * @param {number} periodMs 周期 (ms)
   * @param {number} minPos 最小位置 (0-100)
   * @param {number} maxPos 最大位置 (0-100)
   * @returns {[{at:number,pos:number}]}
   */
  function generateWave(shape, startMs, durationMs, periodMs, minPos, maxPos) {
    const P = Math.max(50, Math.round(periodMs));
    const end = startMs + Math.max(0, Math.round(durationMs));
    const amp = maxPos - minPos;
    const out = [];
    if (shape.startsWith('gw_')) {
      const shapeDef = GEN_WAVE_SHAPES[shape];
      if (!shapeDef) return out;
      const oneCycle = generateFromShape(shapeDef, P, minPos, maxPos);
      let t = startMs;
      while (t < end) {
        for (const p of oneCycle) {
          const at = t + p.at;
          if (at > end) break;
          out.push({ at, pos: p.pos });
        }
        t += P;
      }
      return out;
    }
    const push = (t, pos) => {
      t = Math.round(t); pos = Math.round(clamp(pos, 0, 100));
      if (t > end) return;
      const last = out[out.length - 1];
      if (last && last.at === t) { last.pos = pos; return; }
      out.push({ at: t, pos });
    };
    let t = startMs;
    while (t < end) {
      const before = t;
      switch (shape) {
        case 'sine': {
          const steps = 8, dt = P / steps;
          for (let k = 0; k < steps && t < end; k++, t += dt) {
            const ph = (t - startMs) / P;
            push(t, minPos + amp * (0.5 + 0.5 * Math.sin(2 * Math.PI * ph - Math.PI / 2)));
          }
          break;
        }
        case 'triangle':
          push(t, minPos);
          push(t + P / 2, maxPos);
          t += P;
          break;
        case 'sawUp':
          push(t, minPos);
          push(t + P - 20, maxPos);
          push(t + P, minPos);
          t += P;
          break;
        case 'sawDown':
          push(t, maxPos);
          push(t + P - 20, minPos);
          push(t + P, maxPos);
          t += P;
          break;
        case 'square':
          push(t, minPos);
          push(t + P / 2 - 20, minPos);
          push(t + P / 2, maxPos);
          push(t + P - 20, maxPos);
          t += P;
          break;
        case 'heartbeat':
          push(t, minPos);
          push(t + 0.10 * P, maxPos);
          push(t + 0.18 * P, minPos);
          push(t + 0.28 * P, minPos + amp * 0.55);
          push(t + 0.40 * P, minPos);
          t += P;
          break;
        default:
          return out;
      }
      if (t <= before) t = before + P;
    }
    return out;
  }

  // ---------- .pulse 文件解析 ----------
  const STAGE_TIME_SLIDER = [
    0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000,
    2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000,
    3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800, 3900, 4000,
    4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900, 5000,
    5200, 5400, 5600, 5800, 6000, 6200, 6400, 6600, 6800, 7000,
    7200, 7400, 7600, 7800, 8000, 8500, 9000, 9500, 10000, 11000, 12000,
    13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000,
    23300, 26600, 30000, 33300, 36600, 40000, 45000, 50000, 55000,
    60000, 70000, 80000, 90000, 100000, 120000, 140000, 160000,
    180000, 200000, 250000, 300000
  ];

  /**
   * 解析 Dungeonlab .pulse 文件内容为 actions 数组
   * @param {string} content .pulse 文件原文
   * @returns {[{at:number,pos:number}]}
   */
  function parsePulseToActions(content) {
    const text = content.trim().replace(/\s+/g, '');
    const head = 'Dungeonlab+pulse:';
    const idx = text.indexOf(head);
    if (idx < 0) throw new Error('缺少 Dungeonlab+pulse: 头部，不是有效的 .pulse 文件');
    let data = text.slice(idx + head.length);
    const eq = data.indexOf('=');
    if (eq < 0) throw new Error('文件中没有波形数据');
    const headParts = data.slice(0, eq).split(',');
    const rest = parseInt(headParts[0], 10) || 0;
    let rate = parseInt(headParts[1], 10) || 1;
    if (![1, 2, 4].includes(rate)) rate = 1;
    const metaMs = 100 / rate;

    const out = [];
    let t = 0;
    if (rest > 0) { out.push({ at: 0, pos: 0 }); t += rest * 10; }

    const sections = data.slice(eq + 1).split('+section+').filter(s => s.trim());
    for (const sec of sections) {
      const parts = sec.split('/');
      if (parts.length < 2) continue;
      const info = parts[0].split(',');
      if (info.length < 5) continue;
      if (info[4] !== '1') continue;
      const stageTimeIdx = parseInt(info[2], 10) || 0;
      const stageTime = STAGE_TIME_SLIDER[stageTimeIdx] || 0;
      const metas = parts[1].split(',').filter(s => s.trim())
        .map(s => clamp(Math.round(parseFloat(s.split('-')[0]) || 0), 0, 100));
      if (!metas.length) continue;
      const oneLoop = metas.length * metaMs;
      const loops = stageTime > 0 ? Math.max(1, Math.floor(stageTime / oneLoop)) : 1;
      for (let L = 0; L < loops; L++) {
        for (const y of metas) {
          out.push({ at: Math.round(t), pos: y });
          t += metaMs;
        }
      }
    }
    return out;
  }

  /**
   * 打破平段 — 对连续相同 pos 的长段添加微扰动
   */
  function postProcessFlatSegments(actions, variation = 3, minRun = 3) {
    if (variation <= 0) return actions;
    const out = actions.map(a => ({ ...a }));
    let i = 0;
    while (i < out.length) {
      let j = i + 1;
      while (j < out.length && out[j].pos === out[i].pos) j++;
      const runLen = j - i;
      if (runLen >= minRun) {
        const base = out[i].pos;
        for (let k = i + 1; k < j - 1; k++) {
          const sign = ((k - i) % 2 === 0) ? 1 : -1;
          out[k].pos = clamp(base + sign * variation, 0, 100);
        }
      }
      i = j;
    }
    return out;
  }

  // 导出
  const API = {
    clamp, normalize, viewMs, toData, nearestPoint, draw,
    createPointerHandlers, createPlayer,
    WAVE_SHAPES, generateWave,
    parsePulseToActions, postProcessFlatSegments
  };

  // 浏览器全局
  global.WaveEditorCore = API;
  // CommonJS fallback
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
