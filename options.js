// howl-funscript-events-studio - options app（运行在 sandbox.html 沙箱页中）
// 脚本库管理 + 完整波形编辑器 + 全局设置
// 数据存储：chrome.storage.local { settings, scripts: [{id, filename, url, funscript, monitors}] }
// API 调用：background service worker（HFES_* 消息）
// 注意：沙箱页不能直接使用 chrome.* API，统一通过 postMessage 桥接（broker.js 在壳页面中）

const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;
const ElMessage = ElementPlus.ElMessage;
const Core = window.WaveEditorCore; // wave-editor-core.js（共享波形编辑器核心）

function clamp(v, min, max) { return Core ? Core.clamp(v, min, max) : Math.min(max, Math.max(min, v)); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2); }

function fmtDuration(ms) {
  ms = Math.max(0, Math.round(ms));
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms % 3600000 / 60000))}:${pad(Math.floor(ms % 60000 / 1000))}.${pad(ms % 1000, 3)}`;
}

// ---------------- 沙箱桥接 ----------------
let __reqId = 0;
const __pending = new Map();
window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.__hfes_bridge__ !== true || msg.kind !== 'response') return;
  const p = __pending.get(msg.id);
  if (!p) return;
  __pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || 'bridge error'));
});
function bridgeCall(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++__reqId;
    __pending.set(id, { resolve, reject });
    window.parent.postMessage({ __hfes_bridge__: true, kind: 'request', id, type, payload }, '*');
    setTimeout(() => {
      if (__pending.has(id)) { __pending.delete(id); reject(new Error('桥接超时: ' + type)); }
    }, 30000);
  });
}

// ---------------- 后台消息 / 存储（均走桥接） ----------------
function sendBg(type, extra) {
  return bridgeCall('bg', Object.assign({ type }, extra || {}));
}

async function loadStore() {
  return bridgeCall('getStore');
}

async function setStore(patch) {
  return bridgeCall('setStore', patch);
}

const SAMPLE = {
  metadata: { title: "漫画", duration: 162, durationTime: "00:02:42.000",
    topic_url: "https://discuss.eroscripts.com/t/75758",
    topic_tags: ["osr2", "multi-axis", "blowjob"], topic_creator: "", topic_date: "2022-09-12" },
  events: [
    { id: "page1", metadata: { title: "第一页", duration: 3, durationTime: "00:00:03.081", loop: true },
      actions: [ { at: 7402, pos: 100 }, { at: 7963, pos: 72 }, { at: 8483, pos: 100 }, { at: 8716, pos: 90 },
                 { at: 8923, pos: 50 }, { at: 9363, pos: 100 }, { at: 9676, pos: 90 }, { at: 10003, pos: 50 }, { at: 10483, pos: 100 } ] },
    { id: "page2", metadata: { title: "第二页", duration: 2, durationTime: "00:00:42.633", loop: true },
      actions: [ { at: 8323, pos: 48 }, { at: 8703, pos: 68 }, { at: 9083, pos: 58 }, { at: 9683, pos: 73 },
                 { at: 10083, pos: 54 }, { at: 10203, pos: 48 }, { at: 10956, pos: 68 } ] }
  ],
  version: "1.0"
};

createApp({
  setup() {
    // ================= 全局设置 =================
    const settings = reactive({
      host: 'http://127.0.0.1:9080',
      apiKey: '',
      panelPosition: 'right',
      pushPlay: false
    });

    // 域名规则组：{ id, name, domain, monitors[] } - 用于同一域名的多个监控器共享配置
    const domainRuleGroups = reactive([]);
    const testResult = ref(null);

    async function persistSettings() {
      await setStore({ settings: JSON.parse(JSON.stringify(settings)) });
    }
    watch(settings, persistSettings, { deep: true });

    // ================= 域名规则组管理 =================

    async function loadDomainRuleGroups() {
      const store = await loadStore();
      domainRuleGroups.length = 0;
      if (Array.isArray(store.domainRuleGroups)) {
        domainRuleGroups.push(...store.domainRuleGroups);
      }
    }

    async function saveDomainRuleGroups() {
      const store = await loadStore();
      store.domainRuleGroups = JSON.parse(JSON.stringify(domainRuleGroups));
      await setStore(store);
    }

    // 域名规则组的 CRUD 方法
    const editingRuleGroupId = ref('');
    const editingRuleGroupName = ref('');
    const editingRuleGroupDomain = ref('');
    const editingRuleGroupMonitors = ref([]);
    const editingRuleGroupEnabled = ref(true);
    const ruleGroupDialogVisible = ref(false);

    function getEventIds(s) {
      if (!s || !s.funscript || !Array.isArray(s.funscript.events)) return [];
      return s.funscript.events.map(ev => ev.id || '').filter(Boolean);
    }

    function validateDomain(domain) {
      // 验证域名字符串：支持通配符 *
      const pattern = '^' + domain.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      return new RegExp(pattern).test(location.hostname);
    }

    function addDomainRuleGroup() {
      const last = domainRuleGroups[domainRuleGroups.length - 1];
      const def = last || { enabled: true, type: 'dom', selector: '', observe: 'text', attrName: '', match: 'equals', eventId: '' };
      domainRuleGroups.push({ id: uuid(), name: (def.name || '新规则组') + '_' + (domainRuleGroups.length + 1), domain: (def.domain || ''), enabled: true, monitors: JSON.parse(JSON.stringify(def.monitors || [])) });
    }

    function removeDomainRuleGroup(idx) {
      if (idx >= 0 && idx < domainRuleGroups.length) {
        domainRuleGroups.splice(idx, 1);
        saveDomainRuleGroups();
        ElMessage.success('已删除');
      }
    }

    function editDomainRuleGroup(idx) {
      const group = domainRuleGroups[idx];
      editingRuleGroupId.value = group?.id || '';
      editingRuleGroupName.value = group?.name || '';
      editingRuleGroupDomain.value = group?.domain || '';
      editingRuleGroupMonitors.value = JSON.parse(JSON.stringify(group?.monitors || []));
      ruleGroupDialogVisible.value = true;
    }

    function saveDomainRuleGroup() {
      const idx = domainRuleGroups.findIndex(g => g.id === editingRuleGroupId.value);
      if (idx >= 0) {
        domainRuleGroups[idx].name = editingRuleGroupName.value || '规则组';
        domainRuleGroups[idx].domain = editingRuleGroupDomain.value.trim();
        domainRuleGroups[idx].enabled = editingRuleGroupEnabled.value;
        domainRuleGroups[idx].monitors = JSON.parse(JSON.stringify(editingRuleGroupMonitors.value));
        saveDomainRuleGroups();
        ruleGroupDialogVisible.value = false;
        ElMessage.success('已保存');
      } else {
        // 新规则组
        domainRuleGroups.push({
          id: editingRuleGroupId.value || uuid(),
          name: editingRuleGroupName.value || '规则组',
          domain: editingRuleGroupDomain.value.trim(),
          enabled: editingRuleGroupEnabled.value,
          monitors: JSON.parse(JSON.stringify(editingRuleGroupMonitors.value))
        });
        saveDomainRuleGroups();
        ruleGroupDialogVisible.value = false;
        ElMessage.success('已保存');
      }
    }

    // 辅助函数：从模板中添加监控器到域名规则组编辑列表
    function addDomainRuleGroupMonitor() {
      editingRuleGroupMonitors.value.push({ 
        id: uuid(), 
        enabled: true, 
        type: 'dom', 
        observe: 'text', 
        selector: '', 
        attrName: ''
      });
    }

    // 通过后台消息保存域名规则组
    async function bgSaveDomainRuleGroups() {
      return bridgeCall('bg', { type: 'HFES_SAVE_DOMAIN_RULE_GROUPS', data: domainRuleGroups });
    }

    async function testConnection() {
      if (!settings.host) { testResult.value = { ok: false, text: '请先填写设备地址' }; return ElMessage.warning('请先填写设备地址'); }
      await persistSettings();
      testResult.value = { ok: null, text: '连接中...' };
      const r = await sendBg('HFES_TEST_CONNECTION');
      if (r && r.ok) {
        const t = (r.body && r.body.player && r.body.player.title) || '';
        const msg = '连接成功' + (t ? '，当前播放：' + t : '');
        testResult.value = { ok: true, text: msg };
        ElMessage.success(msg);
      } else {
        const msg = (r && r.error) || '连接失败';
        testResult.value = { ok: false, text: msg };
        ElMessage.error(msg);
      }
    }

    // ================= 脚本库 =================
    const scripts = ref([]);
    const mainTab = ref('list');

    async function refreshScripts() {
      const store = await loadStore();
      scripts.value = store.scripts;
    }

    function scriptTitle(s) {
      return (s.funscript && s.funscript.metadata && s.funscript.metadata.title) || '(无标题)';
    }
    function eventCount(s) {
      return (s.funscript && s.funscript.events) ? s.funscript.events.length : (s.funscript && s.funscript.actions ? 1 : 0);
    }

    function validateFunscript(data) {
      if (!data || typeof data !== 'object') throw new Error('不是有效的 JSON 对象');
      const hasEvents = Array.isArray(data.events) && data.events.length;
      const hasActions = Array.isArray(data.actions);
      if (!hasEvents && !hasActions) throw new Error('缺少 events 或 actions 字段');
      if (hasEvents) {
        data.events.forEach((ev, i) => {
          if (!Array.isArray(ev.actions)) throw new Error(`events[${i}].actions 不是数组`);
        });
      }
      return data;
    }

    const importFileRef = ref(null);
    function triggerImportFile() { importFileRef.value && importFileRef.value.click(); }

    async function onImportFiles(e) {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      let okCount = 0;
      for (const file of files) {
        try {
          const text = await file.text();
          const data = validateFunscript(JSON.parse(text));
          scripts.value.push({ id: uuid(), filename: file.name, url: '', funscript: data, monitors: [] });
          okCount++;
        } catch (err) {
          ElMessage.error(`导入失败 ${file.name}: ${err.message}`);
        }
      }
      if (okCount) {
        await setStore({ scripts: JSON.parse(JSON.stringify(scripts.value)) });
        ElMessage.success(`已导入 ${okCount} 个脚本`);
      }
      e.target.value = '';
    }

    function createNewScript() {
      editingId.value = null;
      editingName.value = '新建脚本';
      applyImport({ metadata: { title: '' }, events: [], version: '1.0' });
      mainTab.value = 'editor';
      nextTick(() => setTimeout(draw, 80));
    }

    function editScript(row) {
      editingId.value = row.id;
      editingName.value = scriptTitle(row);
      applyImport(JSON.parse(JSON.stringify(row.funscript)));
      mainTab.value = 'editor';
      nextTick(() => setTimeout(draw, 80));
    }

    function exitEditing() {
      editingId.value = null;
      editingName.value = '';
    }

    async function saveToLibrary() {
      const data = buildFunscript();
      if (!data.events.length) return ElMessage.warning('脚本没有任何事件，无法保存');
      const store = await loadStore();
      const list = store.scripts;
      if (editingId.value) {
        const idx = list.findIndex(s => s.id === editingId.value);
        if (idx >= 0) {
          list[idx].funscript = data;
          if (!list[idx].filename) list[idx].filename = (data.metadata.title || 'script') + '.funscript';
        } else {
          list.push({ id: uuid(), filename: (data.metadata.title || 'script') + '.funscript', url: '', funscript: data, monitors: [] });
        }
        ElMessage.success('已保存到脚本库');
      } else {
        list.push({ id: uuid(), filename: (data.metadata.title || 'script') + '.funscript', url: '', funscript: data, monitors: [] });
        editingId.value = list[list.length - 1].id;
        editingName.value = scriptTitle({ funscript: data });
        ElMessage.success('已保存为新脚本');
      }
      await setStore({ scripts: list });
      await refreshScripts();
    }

    async function removeScript(row) {
      try {
        await ElementPlus.ElMessageBox.confirm(
          `确定删除脚本「${scriptTitle(row)}」？其关联与监控器配置也会一并删除。`,
          '确认删除', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
        );
      } catch { return; }
      const store = await loadStore();
      store.scripts = store.scripts.filter(s => s.id !== row.id);
      await setStore({ scripts: store.scripts });
      if (editingId.value === row.id) exitEditing();
      await refreshScripts();
      ElMessage.success('已删除');
    }

    // ---------- 关联 ----------
    const assocVisible = ref(false);
    const assocScriptId = ref('');
    const assocScriptName = ref('');
    const assocUrl = ref('');
    const assocUrlPrefix = ref(false);
    const assocTriggers = ref([]);
    const editingId = ref(null);
    const editingName = ref('');
    
    const assocEventIds = computed(() => {
      const s = scripts.value.find(x => x.id === assocScriptId.value);
      if (!s) return [];
      if (s.funscript && Array.isArray(s.funscript.events)) return s.funscript.events.map(ev => ev.id || '').filter(Boolean);
      return [];
    });

    // 所有域名规则组的 monitors，供 trigger 引用
    // 注意：domainRuleGroups 是 reactive([])，不要加 .value
    const allMonitorsForTrigger = computed(() => {
      const result = [];
      for (const g of domainRuleGroups) {
        if (!g.enabled) continue;
        for (const m of (g.monitors || [])) {
          if (m.enabled === false) continue;
          result.push({ ...m, _groupName: g.name, _groupId: g.id });
        }
      }
      return result;
    });

    function addAssocTrigger() {
      // 用上一个触发器做模板（清空 value，eventId 自动设为第一个未占用的）
      const last = assocTriggers.value[assocTriggers.value.length - 1];
      const base = last ? { enabled: last.enabled !== false, monitorId: last.monitorId || '', match: last.match || 'equals' }
                        : { enabled: true, monitorId: '', match: 'equals' };
      // 找第一个未被当前 triggers 占用的 eventId
      const usedIds = new Set(assocTriggers.value.map(t => t.eventId).filter(Boolean));
      const allIds = assocEventIds.value;
      const freeEventId = allIds.find(id => !usedIds.has(id)) || allIds[0] || '';
      assocTriggers.value.push({ id: uuid(), ...base, value: '', eventId: freeEventId });
    }

    function openAssociate(row) {
      if (!eventCount(row)) return ElMessage.warning('该脚本没有事件，请先编辑添加事件');
      assocScriptId.value = row.id;
      assocScriptName.value = scriptTitle(row);
      assocUrl.value = row.url || '';
      assocUrlPrefix.value = row.urlMatch === 'prefix';
      assocTriggers.value = JSON.parse(JSON.stringify(row.triggers || []));
      if (!assocTriggers.value.length) assocTriggers.value.push({ id: uuid(), enabled: true, monitorId: '', match: 'equals', value: '', eventId: assocEventIds.value[0] || '' });
      assocVisible.value = true;
    }

    async function saveAssociate() {
      const url = (assocUrl.value || '').trim();
      const store = await loadStore();
      const list = store.scripts;
      if (url) {
        list.forEach(s => { if (s.id !== assocScriptId.value && s.url === url) { s.url = ''; s.urlMatch = 'exact'; } });
      }
      const target = list.find(s => s.id === assocScriptId.value);
      if (target) {
        target.url = url;
        target.urlMatch = assocUrlPrefix.value ? 'prefix' : 'exact';
        target.triggers = JSON.parse(JSON.stringify(assocTriggers.value));
      }
      await setStore({ scripts: list });
      await refreshScripts();
      assocVisible.value = false;
      ElMessage.success(url ? '已保存关联与监控器' : '已清除关联（监控器保留）');
    }

    // ================= 编辑器（移植自 howl-events-editor.html） =================
    const meta = reactive({ title: '', topic_url: '', topic_tags: '', topic_creator: '', topic_date: '' });
    const version = ref('');

    const events = reactive([]);
    const activeName = ref('0');
    const activeIndex = computed(() => clamp(parseInt(activeName.value) || 0, 0, Math.max(0, events.length - 1)));
    const activeEvent = computed(() => events[activeIndex.value] || null);
    const totalActions = computed(() => events.reduce((s, e) => s + e.actions.length, 0));

    function eventMaxAt(ev) { return ev.actions.length ? Math.max(...ev.actions.map(a => a.at)) : 0; }

    function normalize(i) {
      const ev = events[i]; if (!ev) return;
      if (Core) Core.normalize(ev.actions);
      else { ev.actions.sort((a, b) => a.at - b.at); /* fallback */ }
    }

    function addEvent() {
      events.push({ id: 'page' + (events.length + 1), title: '', loop: true, actions: [] });
      activeName.value = String(events.length - 1);
    }
    function duplicateEvent(i) {
      const src = events[i];
      events.splice(i + 1, 0, { id: src.id + '_copy', title: src.title, loop: src.loop, actions: src.actions.map(a => ({ ...a })) });
      activeName.value = String(i + 1);
    }
    function removeEvent(i) {
      events.splice(i, 1);
      activeName.value = String(Math.min(i, events.length - 1 < 0 ? 0 : events.length - 1));
      if (!events.length) activeName.value = '0';
    }
    function addAction() {
      const ev = activeEvent.value; if (!ev) return;
      const last = ev.actions.length ? ev.actions[ev.actions.length - 1].at : 0;
      ev.actions.push({ at: last + 500, pos: 50 });
      sortDedupe(activeIndex.value);
    }
    function removeAction(idx) { activeEvent.value.actions.splice(idx, 1); clearTableSelection(); }
    function sortDedupe(i) { normalize(i); }
    function invert(i) { events[i].actions.forEach(a => a.pos = 100 - a.pos); }

    const actionsTableRef = ref(null);
    const selectedActions = ref([]);
    const rangeDelStart = ref(null);
    const rangeDelEnd = ref(null);

    function onSelectionChange(rows) { selectedActions.value = rows; }
    function clearTableSelection() {
      const tbl = actionsTableRef.value;
      if (tbl && tbl.clearSelection) tbl.clearSelection();
      selectedActions.value = [];
    }
    function deleteSelected() {
      const ev = activeEvent.value; if (!ev) return;
      if (!selectedActions.value.length) return ElMessage.warning('请先勾选要删除的动作');
      const set = new Set(selectedActions.value);
      ev.actions = ev.actions.filter(a => !set.has(a));
      sortDedupe(activeIndex.value);
      clearTableSelection();
      ElMessage.success(`已删除 ${set.size} 个动作`);
    }
    function clearAllActions() {
      const ev = activeEvent.value; if (!ev || !ev.actions.length) return;
      ElementPlus.ElMessageBox.confirm(
        `确定要清空事件 "${ev.id}" 的全部 ${ev.actions.length} 个动作吗？`,
        '确认清空',
        { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
      ).then(() => {
        ev.actions = [];
        clearTableSelection();
        ElMessage.success('已清空');
      }).catch(() => {});
    }
    function deleteByRange() {
      const ev = activeEvent.value; if (!ev) return;
      const s = rangeDelStart.value, e = rangeDelEnd.value;
      if (s == null || e == null || s > e) return ElMessage.warning('请输入有效的时间范围');
      const before = ev.actions.length;
      ev.actions = ev.actions.filter(a => !(a.at >= s && a.at <= e));
      clearTableSelection();
      const removed = before - ev.actions.length;
      if (!removed) return ElMessage.info(`时间范围 ${s}~${e}ms 内没有动作`);
      ElMessage.success(`已删除 ${removed} 个动作 (${s}~${e}ms)`);
    }

    // ---------- 内置波形生成器（核心已抽至 wave-editor-core.js）----------
    const waveShapes = Core.WAVE_SHAPES;
    const gen = reactive({ shape: 'sine', fromEnd: true, start: 0, duration: 5000, period: 1000, min: 0, max: 100 });
    const generateWaveActions = Core.generateWave;

    function appendWave() {
      const ev = activeEvent.value;
      if (!ev) return ElMessage.warning('请先新增一个事件');
      const base = gen.fromEnd ? eventMaxAt(ev) : Math.max(0, gen.start);
      const list = generateWaveActions(gen.shape, base, gen.duration, gen.period, gen.min, gen.max);
      if (!list.length) return ElMessage.warning('生成的波形为空，请检查参数');
      ev.actions.push(...list.map(a => ({ ...a })));
      sortDedupe(activeIndex.value);
      ElMessage.success(`已添加 ${list.length} 个动作点 (${gen.shape})`);
    }

    // ---------- .pulse 转换（核心已抽至 wave-editor-core.js）----------
    const parsePulseToActions = Core.parsePulseToActions;
    const postProcessFlatSegments = Core.postProcessFlatSegments;

    const pulseDialogVisible = ref(false);
    const pulseText = ref('');
    const pulseFileRef = ref(null);
    const pulseBreakFlat = ref(true);
    const pulseVariation = ref(3);
    function triggerPulseFile() { pulseFileRef.value && pulseFileRef.value.click(); }
    function onPulseFile(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { pulseText.value = reader.result; };
      reader.readAsText(file);
      e.target.value = '';
    }

    function doImportPulse() {
      const ev = activeEvent.value;
      if (!ev) return ElMessage.warning('请先新增一个事件');
      try {
        let actions = Core.parsePulseToActions(pulseText.value);
        if (!actions.length) throw new Error('未解析到波形数据');
        if (pulseBreakFlat.value) {
          const beforeLen = actions.length;
          actions = Core.postProcessFlatSegments(actions, pulseVariation.value, 3);
          ElMessage.info(`已自动打破平段（扰动 ±${pulseVariation.value}），共 ${beforeLen} 点`);
        }
        const base = eventMaxAt(ev);
        ev.actions.push(...actions.map(a => ({ at: a.at + base, pos: a.pos })));
        sortDedupe(activeIndex.value);
        pulseDialogVisible.value = false;
        ElMessage.success(`已转换并添加 ${actions.length} 个动作点`);
      } catch (e) { ElMessage.error(e.message); }
    }

    // ---------- 构建 / 导入 / 导出 ----------
    function buildFunscript() {
      const evs = events.map(ev => {
        const maxAt = eventMaxAt(ev);
        const md = { title: ev.title || null, duration: Math.round(maxAt / 1000), durationTime: fmtDuration(maxAt), loop: !!ev.loop };
        if (!md.title) delete md.title;
        return { id: ev.id, metadata: md, actions: ev.actions.map(a => ({ at: Math.round(a.at), pos: Math.round(a.pos) })) };
      });
      const overallMax = events.reduce((m, ev) => Math.max(m, eventMaxAt(ev)), 0);
      const metadata = { title: meta.title || '', duration: Math.round(overallMax / 1000), durationTime: fmtDuration(overallMax) };
      if (meta.topic_url) metadata.topic_url = meta.topic_url;
      const tags = meta.topic_tags.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (tags.length) metadata.topic_tags = tags;
      if (meta.topic_creator) metadata.topic_creator = meta.topic_creator;
      if (meta.topic_date) metadata.topic_date = meta.topic_date;
      return { metadata, events: evs, version: version.value || '1.1' };
    }

    const funscriptJson = computed(() => JSON.stringify(buildFunscript(), null, 2));

    async function copyJson() {
      try { await navigator.clipboard.writeText(funscriptJson.value); ElMessage.success('已复制到剪贴板'); }
      catch { ElMessage.error('复制失败，请手动从下方文本框复制'); }
    }
    function downloadJson() {
      const blob = new Blob([funscriptJson.value], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (meta.title || 'events') + '.funscript';
      a.click(); URL.revokeObjectURL(a.href);
    }

    const importDialogVisible = ref(false);
    const importText = ref('');
    function doImport() {
      try {
        const data = validateFunscript(JSON.parse(importText.value));
        applyImport(data);
        importDialogVisible.value = false;
        ElMessage.success('导入成功（仅进入编辑器，保存请点「保存为新脚本」）');
      } catch (e) { ElMessage.error('JSON 解析失败: ' + e.message); }
    }
    async function doImportAndSave() {
      try {
        const data = validateFunscript(JSON.parse(importText.value));
        applyImport(data);
        importDialogVisible.value = false;
        editingId.value = null;
        await saveToLibrary();
      } catch (e) { ElMessage.error('JSON 解析失败: ' + e.message); }
    }
    function applyImport(data) {
      events.splice(0, events.length);
      const list = Array.isArray(data.events) && data.events.length
        ? data.events
        : (Array.isArray(data.actions) ? [{ id: 'page1', metadata: { title: '第一页', loop: true }, actions: data.actions }] : []);
      list.forEach((ev, i) => {
        events.push({
          id: ev.id || ('page' + (i + 1)),
          title: (ev.metadata && ev.metadata.title) || '',
          loop: ev.metadata ? ev.metadata.loop !== false : true,
          actions: (ev.actions || []).map(a => ({ at: a.at, pos: a.pos }))
        });
        normalize(i);
      });
      const md = data.metadata || {};
      meta.title = md.title || '';
      meta.topic_url = md.topic_url || '';
      meta.topic_tags = Array.isArray(md.topic_tags) ? md.topic_tags.join(',') : (md.topic_tags || '');
      meta.topic_creator = md.topic_creator || '';
      meta.topic_date = md.topic_date || '';
      version.value = (typeof data.version === 'string' && data.version) || '1.0';
      activeName.value = '0';
    }
    function loadSample() { applyImport(JSON.parse(JSON.stringify(SAMPLE))); ElMessage.success('示例已加载'); }

    // ---------- 推送到设备 ----------
    async function pushToDevice() {
      if (!settings.host) return ElMessage.warning('请先在顶部或设置页填写设备地址');
      if (!settings.apiKey) return ElMessage.warning('请填写 API Key (应用「设置 → 远程控制」中查看)');
      const r = await sendBg('HFES_PUSH_FUNSCRIPT', {
        title: meta.title || 'Events Script',
        loop: false,
        play: settings.pushPlay,
        funscript: funscriptJson.value
      });
      if (r && r.ok) ElMessage.success('推送成功: ' + ((r.body && r.body.player && r.body.player.title) || ''));
      else ElMessage.error('推送失败: ' + ((r && r.error) || '未知错误'));
    }

    // ---------- 画布编辑 ----------
    const canvasRef = ref(null);
    function getCanvas() {
      const arr = canvasRef.value;
      return Array.isArray(arr) ? arr[activeIndex.value] : arr;
    }
    const playing = ref(false);
    const playheadMs = ref(0);
    let dragIdx = -1;
    let rafId = null;
    let playStart = 0;

    let selStartX = 0, selStartY = 0;
    let selCurX = 0, selCurY = 0;
    let isRightSelecting = false;
    let isRightClick = false;

    const viewMs = computed(() => {
      const ev = activeEvent.value;
      return Core ? Core.viewMs(ev ? ev.actions : []) : Math.max(5000, Math.ceil((ev ? eventMaxAt(ev) : 0) / 1000) * 1000);
    });

    function toData(evt) {
      return Core ? Core.toData(evt, getCanvas(), viewMs.value) : (() => {
        const rect = getCanvas().getBoundingClientRect();
        const x = evt.clientX - rect.left, y = evt.clientY - rect.top;
        return { ms: clamp(x / rect.width, 0, 1) * viewMs.value, pos: (1 - clamp(y / rect.height, 0, 1)) * 100, x, y };
      })();
    }
    function nearestPoint(x, y) {
      const ev = activeEvent.value; if (!ev || !ev.actions.length) return { idx: -1, dist: Infinity };
      if (Core) return Core.nearestPoint(ev.actions, getCanvas(), x, y, viewMs.value);
      const rect = getCanvas().getBoundingClientRect();
      let best = { idx: -1, dist: Infinity };
      ev.actions.forEach((a, i) => {
        const px = a.at / viewMs.value * rect.width, py = (1 - a.pos / 100) * rect.height;
        const d = Math.hypot(px - x, py - y);
        if (d < best.dist) best = { idx: i, dist: d };
      });
      return best;
    }
    function onPointerDown(e) {
      const ev = activeEvent.value; if (!ev) return;
      getCanvas().setPointerCapture(e.pointerId);
      const { x, y, ms, pos } = toData(e);
      if (e.button === 2) {
        selStartX = selCurX = x; selStartY = selCurY = y;
        isRightClick = true;
        isRightSelecting = false;
        return;
      }
      const { idx, dist } = nearestPoint(x, y);
      if (idx >= 0 && dist <= 12) { dragIdx = idx; }
      else {
        const p = { at: Math.round(ms), pos: Math.round(clamp(pos, 0, 100)) };
        ev.actions.push(p); sortDedupe(activeIndex.value);
        dragIdx = ev.actions.indexOf(p);
      }
    }
    function onPointerMove(e) {
      const { x, y } = toData(e);
      if (isRightClick) {
        selCurX = x; selCurY = y;
        if (!isRightSelecting && Math.hypot(x - selStartX, y - selStartY) > 5) {
          isRightSelecting = true;
        }
        if (isRightSelecting) draw();
        return;
      }
      if (dragIdx < 0) return;
      const ev = activeEvent.value; const p = ev && ev.actions[dragIdx]; if (!p) return;
      const { ms, pos } = toData(e);
      p.at = Math.max(0, Math.round(ms)); p.pos = Math.round(clamp(pos, 0, 100));
    }
    function onPointerUp(e) {
      if (isRightClick) {
        const ev = activeEvent.value;
        if (ev) {
          if (isRightSelecting) {
            const rect = getCanvas().getBoundingClientRect();
            const xMin = Math.min(selStartX, selCurX), xMax = Math.max(selStartX, selCurX);
            const yMin = Math.min(selStartY, selCurY), yMax = Math.max(selStartY, selCurY);
            const before = ev.actions.length;
            ev.actions = ev.actions.filter(a => {
              const px = a.at / viewMs.value * rect.width;
              const py = (1 - a.pos / 100) * rect.height;
              return !(px >= xMin && px <= xMax && py >= yMin && py <= yMax);
            });
            sortDedupe(activeIndex.value);
            clearTableSelection();
            const removed = before - ev.actions.length;
            if (removed) ElMessage.success(`框选删除 ${removed} 个动作`);
          } else {
            const { idx, dist } = nearestPoint(selStartX, selStartY);
            if (idx >= 0 && dist <= 12) { ev.actions.splice(idx, 1); clearTableSelection(); }
          }
        }
        isRightClick = false; isRightSelecting = false;
        draw();
        return;
      }
      if (dragIdx >= 0) { sortDedupe(activeIndex.value); dragIdx = -1; }
    }
    function onContextMenu(e) { e.preventDefault(); }

    function draw() {
      const canvas = getCanvas(); if (!canvas || !canvas.getContext) return;
      const ev = activeEvent.value;
      const ctx = canvas.getContext('2d');
      if (Core) {
        Core.draw(ctx, canvas, ev ? ev.actions : [], {
          dragIdx, playing: playing.value, playheadMs: playheadMs.value,
          isRightSelecting, selStartX, selStartY, selCurX, selCurY,
          vm: viewMs.value
        });
        return;
      }
      // fallback 原始实现（core 未加载时用）
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const vm = viewMs.value;
      const X = ms => ms / vm * w, Y = pos => (1 - pos / 100) * h;
      ctx.strokeStyle = '#e4e7ed'; ctx.fillStyle = '#909399'; ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
      const secStep = vm > 60000 ? 10 : (vm > 20000 ? 5 : 1);
      for (let s = 0; s <= vm / 1000; s += secStep) {
        const x = X(s * 1000);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.fillText(s + 's', x + 2, h - 4);
      }
      [0, 25, 50, 75, 100].forEach(p => { const y = Y(p); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.fillText(String(p), 3, y - 3); });
      if (ev && ev.actions.length) {
        ctx.strokeStyle = '#409eff'; ctx.lineWidth = 2; ctx.beginPath();
        ev.actions.forEach((a, i) => i ? ctx.lineTo(X(a.at), Y(a.pos)) : ctx.moveTo(X(a.at), Y(a.pos)));
        if (ev.actions.length === 1) ctx.lineTo(X(ev.actions[0].at) + 1, Y(ev.actions[0].pos));
        ctx.stroke();
        ev.actions.forEach((a, i) => { ctx.beginPath(); ctx.arc(X(a.at), Y(a.pos), i === dragIdx ? 6 : 4, 0, Math.PI * 2); ctx.fillStyle = i === dragIdx ? '#e6a23c' : '#409eff'; ctx.fill(); });
      }
      if (playing.value) { const x = X(playheadMs.value); ctx.strokeStyle = '#f56c6c'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      if (isRightSelecting) {
        const xMin = Math.min(selStartX, selCurX), xMax = Math.max(selStartX, selCurX), yMin = Math.min(selStartY, selCurY), yMax = Math.max(selStartY, selCurY);
        ctx.fillStyle = 'rgba(64,158,255,0.15)'; ctx.fillRect(xMin, yMin, xMax - xMin, yMax - yMin);
        ctx.strokeStyle = 'rgba(64,158,255,0.8)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.strokeRect(xMin, yMin, xMax - xMin, yMax - yMin); ctx.setLineDash([]);
      }
    }

    function togglePlay() {
      if (playing.value) { stopPlay(); return; }
      playing.value = true; playheadMs.value = 0; playStart = performance.now();
      const tick = now => {
        if (!playing.value) return;
        playheadMs.value = now - playStart;
        if (playheadMs.value >= viewMs.value) {
          const ev = activeEvent.value;
          if (ev && ev.loop) { playStart = now; playheadMs.value = 0; }
          else { playing.value = false; playheadMs.value = 0; draw(); return; }
        }
        draw();
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }
    function stopPlay() { playing.value = false; playheadMs.value = 0; if (rafId) cancelAnimationFrame(rafId); draw(); }

    watch([events, activeName], () => nextTick(draw), { deep: true });
    watch(playing, v => { if (!v && rafId) cancelAnimationFrame(rafId); });

    function onMainTabChange(tab) {
      if (tab === 'editor') nextTick(() => setTimeout(draw, 60));
    }

    onMounted(async () => {
      const store = await loadStore();
      Object.assign(settings, store.settings);
      scripts.value = store.scripts;
      // 同时加载域名规则组（监控器）
      domainRuleGroups.length = 0;
      if (Array.isArray(store.domainRuleGroups)) {
        domainRuleGroups.push(...store.domainRuleGroups);
      }
      draw();
      window.addEventListener('resize', draw);
    });

    return {
      // 设置
      settings, testResult, testConnection,
      // 脚本库
      scripts, mainTab, refreshScripts, scriptTitle, eventCount,
      triggerImportFile, importFileRef, onImportFiles, createNewScript,
      editScript, exitEditing, saveToLibrary, removeScript,
      // 关联
      assocVisible, assocScriptName, assocUrl, assocUrlPrefix, assocTriggers, assocEventIds, allMonitorsForTrigger,
      addAssocTrigger, openAssociate, saveAssociate,
      // 域名规则组
      domainRuleGroups, addDomainRuleGroup, removeDomainRuleGroup, editDomainRuleGroup,
      saveDomainRuleGroup, ruleGroupDialogVisible, editingRuleGroupId, editingRuleGroupName, editingRuleGroupDomain, editingRuleGroupMonitors, editingRuleGroupEnabled,
      addDomainRuleGroupMonitor,
      // 编辑器
      meta, version, events, activeName, activeIndex, activeEvent, totalActions, eventMaxAt,
      addEvent, duplicateEvent, removeEvent, addAction, removeAction, sortDedupe, invert,
      funscriptJson, copyJson, downloadJson, importDialogVisible, importText, doImport, doImportAndSave, loadSample,
      pushToDevice, fmtDuration, editingId, editingName,
      canvasRef, playing, onPointerDown, onPointerMove, onPointerUp, onContextMenu, togglePlay,
      waveShapes, gen, appendWave,
      pulseDialogVisible, pulseText, pulseFileRef, pulseBreakFlat, pulseVariation, triggerPulseFile, onPulseFile, doImportPulse,
      actionsTableRef, selectedActions, rangeDelStart, rangeDelEnd,
      onSelectionChange, deleteSelected, clearAllActions, deleteByRange,
      onMainTabChange
    };
  }
}).use(ElementPlus).mount('#app');
