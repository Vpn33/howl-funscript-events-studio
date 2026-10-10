// howl-funscript-events-studio - options app（运行在 sandbox.html 沙箱页中）
// 脚本库管理 + 完整波形编辑器 + 全局设置
// 注意：沙箱页不能直接使用 chrome.* API，统一通过 postMessage 桥接（broker.js 在壳页面中）

const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;
const ElMessage = ElementPlus.ElMessage;
const ElMessageBox = ElementPlus.ElMessageBox;
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

// ---------------- 后台消息 / 存储（通过 postMessage 桥接到 broker.js）----------------
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
  metadata: {
    title: "漫画", duration: 162, durationTime: "00:02:42.000",
    topic_url: "https://discuss.eroscripts.com/t/75758",
    topic_tags: ["osr2", "multi-axis", "blowjob"], topic_creator: "", topic_date: "2022-09-12"
  },
  events: [
    {
      id: "page1", metadata: { title: "第一页", duration: 3, durationTime: "00:00:03.081", loop: true },
      actions: [{ at: 7402, pos: 100 }, { at: 7963, pos: 72 }, { at: 8483, pos: 100 }, { at: 8716, pos: 90 },
      { at: 8923, pos: 50 }, { at: 9363, pos: 100 }, { at: 9676, pos: 90 }, { at: 10003, pos: 50 }, { at: 10483, pos: 100 }]
    },
    {
      id: "page2", metadata: { title: "第二页", duration: 2, durationTime: "00:00:42.633", loop: true },
      actions: [{ at: 8323, pos: 48 }, { at: 8703, pos: 68 }, { at: 9083, pos: 58 }, { at: 9683, pos: 73 },
      { at: 10083, pos: 54 }, { at: 10203, pos: 48 }, { at: 10956, pos: 68 }]
    }
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
      pushPlay: false,
      allowedHosts: [],
      zoomMin: 500        // 默认最大显示范围 (ms)
    });
    const displayRangeMs = ref(settings.zoomMin);  // 当前显示范围（从末尾开始，单位 ms）

    // 从 store 加载保存的 settings（通过 broker.js 桥接）
    onMounted(async () => {
      try {
        const stored = await loadStore();
        console.log('[options] 加载设置:', stored.settings);
        if (stored.settings && stored.settings.zoomMin !== undefined) {
          settings.zoomMin = stored.settings.zoomMin;
          displayRangeMs.value = settings.zoomMin;
          console.log('[options] 使用已保存的 zoomMin:', settings.zoomMin, 'ms');
        } else {
          console.log('[options] 使用默认 zoomMin:', settings.zoomMin, 'ms');
        }
      } catch (e) {
        console.warn('[options] 加载设置失败:', e);
      }
    });

    // 域名规则组：{ id, name, domain, monitors[] } - 用于同一域名的多个监控器共享配置
    const domainRuleGroups = reactive([]);
    const testResult = ref(null);

    // ---- 监听网站白名单 ----
    const allowedHostsSaved = ref(false);

    // Canvas 缩放设置
    const zoomMinSaved = ref(false);
    const allowedHostsText = computed({
      get: () => (settings.allowedHosts || []).join('\n'),
      set: (val) => {
        settings.allowedHosts = val.split('\n').map(s => s.trim()).filter(Boolean);
      }
    });
    function saveAllowedHosts() {
      console.log("saveAllowedHosts")
      persistSettings();
      allowedHostsSaved.value = true;
      setTimeout(() => { allowedHostsSaved.value = false; }, 2000);
    }

    // Canvas 缩放设置保存
    function saveZoomMin() {
      console.log('[saveZoomMin] settings.zoomMin:', settings.zoomMin, 'ms')
      const ms = settings.zoomMin;  // zoomMin 已经是毫秒单位了
      if (ms < 100) {
        ElMessage.warning('请输入至少 0.1 秒（100ms）的时间范围');
        return;
      }
      persistSettings();
      zoomMinSaved.value = true;
      setTimeout(() => { zoomMinSaved.value = false; }, 2000);
    }

    let persistTimer = null;
    async function persistSettings() {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(async () => {
        await setStore({ settings: JSON.parse(JSON.stringify(settings)) });
        console.log('[persistSettings] 保存设置:', settings.zoomMin, 'ms');
      }, 400);
    }
    watch(settings, persistSettings, { deep: true });

    // ---- 备份 / 恢复 ----
    function pickBackupFile() {
      const el = document.getElementById('backupFileInput');
      if (el) el.click();
    }
    async function doBackup() {
      const resp = await sendBg('HFES_BACKUP');
      if (!resp || !resp.ok) { ElMessage.error('备份失败'); return; }
      const blob = new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url; a.download = `hfes-backup-${ts}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      ElMessage.success('备份已下载');
    }
    async function onRestoreFile(e) {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object') throw new Error('格式错误');
        await ElMessageBox.confirm('恢复会覆盖当前所有设置、脚本和监控器，确定继续吗？', '恢复确认', {
          confirmButtonText: '确定恢复', cancelButtonText: '取消', type: 'warning'
        });
        const resp = await sendBg('HFES_RESTORE', { data });
        if (resp && resp.ok) {
          ElMessage.success('恢复成功，即将刷新…');
          setTimeout(() => location.reload(), 1000);
        } else {
          ElMessage.error('恢复失败');
        }
      } catch (err) {
        if (err !== 'cancel') ElMessage.error('恢复失败: ' + err.message);
      }
      e.target.value = '';
    }

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
          // 级联重命名：按位置对比新旧事件 ID，把触发器里引用的旧 ID 同步为新 ID，
          // 保证关联数据（content 面板触发器）始终指向最新的事件
          const oldEvents = (list[idx].funscript && Array.isArray(list[idx].funscript.events)) ? list[idx].funscript.events : [];
          const renameMap = {};
          data.events.forEach((ne, i) => {
            const oldId = oldEvents[i] ? (oldEvents[i].id || '') : '';
            const newId = ne.id || '';
            if (oldId && newId && oldId !== newId) renameMap[oldId] = newId;
          });
          if (Object.keys(renameMap).length && Array.isArray(list[idx].triggers)) {
            list[idx].triggers.forEach(t => { if (t && renameMap[t.eventId]) t.eventId = renameMap[t.eventId]; });
          }
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

    // 时间范围筛选（秒）- 已改为 displayRangeMs
    // const viewRangeMs = ref(10000);

    function eventMaxAt(ev) { return ev.actions.length ? Math.max(...ev.actions.map(a => a.at)) : 0; }

    // 查找第一个有效数据的起点
    function getFirstActionAt(ev) {
      if (!ev || !ev.actions.length) return 0;
      let firstAt = Infinity;
      ev.actions.forEach(a => {
        if (a.at < firstAt) firstAt = a.at;
      });
      return firstAt > 0 ? firstAt : 0;
    }

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

    // 过滤后的动作列表（显示当前视图范围内的动作）
    const filteredActions = computed(() => {
      const ev = activeEvent.value;
      if (!ev) return [];
      const maxAt = eventMaxAt(ev);
      
      // 计算当前视图的 offsetMs，确保与 Core.draw 一致
      let offsetMs;
      if (scrollOffsetMs.value === 0 && !isScrollDragging) {
        // 初始加载时，从第一个数据点开始
        offsetMs = getFirstActionAt(ev);
      } else {
        // 用户操作后，使用 scrollOffsetMs
        offsetMs = Math.max(getFirstActionAt(ev), Math.min(scrollOffsetMs.value, maxAt - displayRangeMs.value));
      }
      
      const startMs = offsetMs;
      const endMs = Math.min(maxAt, offsetMs + displayRangeMs.value);
      
      console.log(`[filteredActions] 裁剪范围：${startMs}ms ~ ${endMs}ms (offsetMs: ${offsetMs})`);
      
      // 添加调试日志，显示第一个和最后一个节点的 at 值
      if (ev.actions.length > 0) {
        const firstAt = getFirstActionAt(ev);
        console.log(`[filteredActions] all actions: firstAt=${firstAt}, maxAt=${maxAt}`);
      }
      
      const beforeLen = ev.actions.length;
      const filtered = ev.actions.filter(a => a.at >= startMs && a.at <= endMs);
      const afterLen = filtered.length;
      
      console.log(`[filteredActions] 从 ${beforeLen} 个节点过滤到 ${afterLen} 个节点`);
      
      return filtered;
    });

    // 滚动条状态
    const scrollBarVisible = computed(() => {
      const ev = activeEvent.value;
      if (!ev || !ev.actions.length) return false;
      const maxAt = eventMaxAt(ev);
      return maxAt > displayRangeMs.value;
    });
    const scrollBarThumbWidth = computed(() => {
      const ev = activeEvent.value;
      if (!ev || !ev.actions.length) return 100;
      const maxAt = eventMaxAt(ev);
      return Math.max(5, (displayRangeMs.value / maxAt) * 100);  // 百分比，最小 5%
    });
    const scrollBarThumbLeft = computed(() => {
      const ev = activeEvent.value;
      if (!ev || !ev.actions.length) return 0;
      const maxAt = eventMaxAt(ev);
      const maxOffset = Math.max(1, maxAt - displayRangeMs.value);
      return (scrollOffsetMs.value / maxOffset) * (100 - scrollBarThumbWidth.value);
    });

    function onScrollBarMouseDown(e) {
      isScrollDragging = true;
      const track = e.currentTarget;
      const trackRect = track.getBoundingClientRect();
      const updateOffset = (clientX) => {
        const ev = activeEvent.value;
        if (!ev || !ev.actions.length) return;
        const maxAt = eventMaxAt(ev);
        const maxOffset = Math.max(0, maxAt - displayRangeMs.value);
        if (maxOffset <= 0) return;
        const ratio = Math.max(0, Math.min(1, (clientX - trackRect.left) / trackRect.width));
        scrollOffsetMs.value = ratio * maxOffset;
        draw();
      };
      updateOffset(e.clientX);
      const onMove = (e2) => { if (isScrollDragging) updateOffset(e2.clientX); };
      const onUp = () => { isScrollDragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    function applyViewRange() {
      const ms = displayRangeMs.value;
      if (ms < 1000) {
        ElMessage.warning('请输入至少 1 秒的时间范围');
        return;
      }
      ElMessage.success(`已切换到最近 ${ms / 1000} 秒的视图`);
    }

    // 获取 action 在原始数组中的索引
    function origIdx(row) {
      const ev = activeEvent.value;
      if (!ev || !ev.actions) return 0;
      return ev.actions.indexOf(row);
    }

    // 点击表格行高亮 canvas 节点
    function onTableRowClick(row) {
      const ev = activeEvent.value;
      if (!ev || !ev.actions.length) return;
      // 使用全数组索引（与 dragIdx 保持一致）
      highlightIdx.value = ev.actions.indexOf(row);
      draw();
    }

    // 表格行高亮样式方法（使用 at+pos 匹配，不依赖索引）
    const highlightedRowClass = (row, rowIndex) => {
      // console.log(`[highlightedRowClass] row=${JSON.stringify(row)}, rowIndex=${rowIndex}, typeof row=${typeof row}`);
      
      if (!activeEvent || !activeEvent.value) {
        // console.warn('[highlightedRowClass] activeEvent is null/undefined');
        return '';
      }
      const ev = activeEvent.value;
      if (!ev.actions || !Array.isArray(ev.actions)) {
        // console.warn('[highlightedRowClass] ev.actions is not an array');
        return '';
      }
      
      // 通过 at+pos 查找高亮节点（不依赖索引）
      let highlightedNode = null;
      if (typeof highlightIdx.value === 'number' && highlightIdx.value >= 0 && highlightIdx.value < ev.actions.length) {
        highlightedNode = ev.actions[highlightIdx.value];
      }
      
      // 如果没有设置索引，尝试通过鼠标点击位置反向查找（可选）
      if (!highlightedNode) {
        // console.warn('[highlightedRowClass] Cannot determine highlighted node');
        return '';
      }
      
      // 确保 row 对象有 at 和 pos，尝试多种方式获取
      let rowAt = row.at;
      let rowPos = row.pos;
      
      if (rowAt === undefined) {
        // Element Plus 表格有时会嵌套传递数据：{row: {at, pos}, rowIndex}
        if (row && typeof row === 'object' && row.row && typeof row.row === 'object') {
          rowAt = row.row.at;
          rowPos = row.row.pos;
        } else if (Array.isArray(row)) {
          rowAt = row[0]?.at || row.at;
        } else if (typeof row === 'object') {
          rowAt = row['at'] || row.time || row.ms || undefined;
        }
      }
      
      if (rowPos === undefined) {
        if (row && typeof row === 'object' && row.row && typeof row.row === 'object') {
          rowPos = row.row.pos;
        } else if (Array.isArray(row)) {
          rowPos = row[0]?.pos || row.pos;
        } else if (typeof row === 'object') {
          rowPos = row['pos'] || row.position || row.y || undefined;
        }
      }
      
      // console.log(`[highlightedRowClass] Comparing row(at=${rowAt}, pos=${rowPos}) with highlighted(at=${highlightedNode.at}, pos=${highlightedNode.pos})`);
      
      // 比较 at 和 pos 是否匹配（允许微小误差）
      const atDiff = Math.abs((rowAt || 0) - (highlightedNode.at || 0));
      const posDiff = Math.abs((rowPos || 0) - (highlightedNode.pos || 0));
      // console.log(`[highlightedRowClass] at diff=${atDiff}, pos diff=${posDiff}`);
      
      return (atDiff < 1 && posDiff < 1) ? 'table-row-highlight' : '';
    };

    // 滚动到指定的表格行（如果不在可视区域内）
    const scrollToHighlightedRow = (node) => {
      if (!node) return;
      
      console.log('[scrollToHighlightedRow] node:', node.at, node.pos);
      
      // 在 filteredActions 中查找匹配的节点
      const targetIndex = filteredActions.value.findIndex(a => 
        Math.abs((a.at || 0) - (node.at || 0)) < 1 &&
        Math.abs((a.pos || 0) - (node.pos || 0)) < 1
      );
      
      console.log('[scrollToHighlightedRow] targetIndex:', targetIndex);
      
      if (targetIndex >= 0) {
        // 使用 nextTick 等待 DOM 更新后再滚动
        nextTick(() => {
          const table = document.querySelector('#actionsTable');
          
          if (table) {
            const tbody = table.querySelector('tbody');
            
            if (tbody) {
              const rows = Array.from(tbody.querySelectorAll('tr'));
              
              if (rows[targetIndex]) {
                const targetRow = rows[targetIndex];
                
                // 使用 scrollIntoView 让行进入可视区域
                targetRow.scrollIntoView({ block: 'nearest', behavior: 'auto' });
              } else {
                console.warn('[scrollToHighlightedRow] target row not found at index', targetIndex);
              }
            }
          }
        });
      } else {
        console.warn('[scrollToHighlightedRow] no matching row found');
      }
    };

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
      }).catch(() => { });
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

    // 缩放相关状态（使用响应式变量以便 Vue 追踪变化）
    const currentZoomMin = ref(settings.zoomMin);  // 当前设置的最大显示范围 (ms)
    const scrollOffsetMs = ref(0);  // 当前滚动偏移（数据起始时间 ms）
    let touchStartDist = 0;
    let touchStartScale = 1;
    let isPinching = false;
    let isScrollDragging = false;  // 是否正在拖动滚动条
    const highlightIdx = ref(-1);  // 表格点击高亮的节点索引（全数组索引）

    let selStartX = 0, selStartY = 0;
    let selCurX = 0, selCurY = 0;
    let isRightSelecting = false;
    let isRightClick = false;

    const viewMs = computed(() => {
      const ev = activeEvent.value;
      if (!ev || !ev.actions.length) return displayRangeMs.value;

      // 始终使用 displayRangeMs 作为最大显示范围，如果脚本总时长超过它，则裁剪到最近 displayRangeMs
      const maxAt = eventMaxAt(ev);
      const finalViewMs = Math.min(maxAt, displayRangeMs.value);

      console.log(`[viewMs] maxAt: ${maxAt}, displayRangeMs: ${displayRangeMs.value}, viewMs: ${finalViewMs}`);

      return finalViewMs;
    });

    // 保存当前视图的 offsetMs，供 toData 和 nearestPoint 使用
    let currentOffsetMs = scrollOffsetMs.value;

    function toData(evt) {
      return Core ? Core.toData(evt, getCanvas(), displayRangeMs.value, currentOffsetMs) : (() => {
        const rect = getCanvas().getBoundingClientRect();
        const x = evt.clientX - rect.left, y = evt.clientY - rect.top;
        return { ms: clamp(x / rect.width, 0, 1) * displayRangeMs.value + currentOffsetMs, pos: (1 - clamp(y / rect.height, 0, 1)) * 100, x, y };
      })();
    }
    function nearestPoint(canvas, mouseX, mouseY) {
      const ev = activeEvent.value; if (!ev || !ev.actions.length) return { idx: -1, dist: Infinity };
      
      // 使用实际显示的 offsetMs（与 Core.draw 一致）
      const actualOffset = scrollOffsetMs.value === 0 && !isScrollDragging ? getFirstActionAt(ev) : Math.max(getFirstActionAt(ev), Math.min(scrollOffsetMs.value, eventMaxAt(ev) - displayRangeMs.value));
      
      if (Core) {
        // 使用 Core.nearestPoint（已包含 padding 逻辑）
        // mouseX, mouseY 是原始鼠标坐标（包含 padding）
        return Core.nearestPoint(ev.actions, canvas, mouseX, mouseY, displayRangeMs.value, actualOffset);
      }
      
      // fallback: fallback 到本地实现（与 draw 一致）
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      let best = { idx: -1, dist: Infinity };
      ev.actions.forEach((a, i) => {
        // 使用与 Core.draw 相同的 X/Y 映射公式（考虑 padding）
        // mouseX, mouseY 是原始鼠标坐标，需要转换为数据坐标空间进行比较
        const px = ((a.at - actualOffset) / displayRangeMs.value * width + (width * 0.05)), 
              py = (1 - a.pos / 100) * rect.height - (rect.height * 0.05);
        // 直接使用原始鼠标坐标与数据点映射坐标比较
        const d = Math.hypot(mouseX - px, mouseY - py);
        if (d < best.dist) best = { idx: i, dist: d };
      });
      return best;
    }
    function onPointerDown(e) {
      const ev = activeEvent.value; if (!ev) return;
      getCanvas().setPointerCapture(e.pointerId);
      const canvas = getCanvas();
      const rect = canvas.getBoundingClientRect();
      console.log(`[onPointerDown] mouse X=${e.clientX}, Y=${e.clientY}`);
      
      // 计算 padding（与 Core.draw 完全一致，使用 CSS 像素）
      const paddingX = rect.width * 0.05;
      const paddingY = rect.height * 0.05;
      
      // 将鼠标坐标转换为 canvas 坐标系（减去 padding）
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const clickX = mouseX > paddingX ? mouseX - paddingX : 0;
      const clickY = mouseY > paddingY ? mouseY - paddingY : 0;
      
      console.log(`[onPointerDown] canvas X=${clickX}, Y=${clickY}, paddingX=${paddingX}, paddingY=${paddingY}`);
      
      const { ms, pos } = toData({ clientX: e.clientX, clientY: e.clientY });
      console.log(`[onPointerDown] converted to data: ms=${ms}, pos=${pos}`);
      
      if (e.button === 2) {
        selStartX = selCurX = x; selStartY = selCurY = y;
        isRightClick = true;
        isRightSelecting = false;
        return;
      }
      
      // 计算节点位置时也要考虑 padding（与 Core.draw 一致）
      // 使用原始鼠标坐标（包含 padding），与 nearestPoint 的坐标系统一致
      const { idx, dist } = nearestPoint(canvas, mouseX, mouseY);
      console.log(`[onPointerDown] nearestPoint: idx=${idx}, dist=${dist}`);
      if (idx >= 0) {
        const node = ev.actions[idx];
        console.log(`[onPointerDown] selected node: at=${node.at}, pos=${node.pos}`);
      }
      if (idx >= 0 && dist <= 80) { 
        dragIdx = idx;  // 点击节点后取消拖拽状态（不是拖动）
        // canvas 点击节点时，同时设置 highlightIdx（与表格行点击逻辑一致）
        const node = ev.actions[idx];
        // 使用 at+pos 匹配找到 filteredActions 中的索引
        const highlightedNode = filteredActions.value.find(fa => 
          Math.abs((fa.at || 0) - (node.at || 0)) < 1 &&
          Math.abs((fa.pos || 0) - (node.pos || 0)) < 1
        );
        if (highlightedNode) {
          highlightIdx.value = ev.actions.indexOf(highlightedNode);
        } else {
          // 如果没有找到，使用全数组索引（兼容情况）
          highlightIdx.value = idx;
        }
        
        console.log(`[onPointerDown] highlightIdx set to: ${highlightIdx.value}`);
        
        // 滚动到可视区域（如果高亮行不在视图内）
        scrollToHighlightedRow(node);
        
        draw();  // 重绘 canvas 显示高亮样式
      } else {
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
              const px = (a.at - scrollOffsetMs.value) / displayRangeMs.value * rect.width;
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
        // 计算当前视图的 offsetMs，确保与 filteredActions 一致
        const maxAt = eventMaxAt(ev);
        
        let actualOffsetMs;
        if (scrollOffsetMs.value === 0 && !isScrollDragging) {
          // 初始加载时，使用第一个数据点作为偏移量
          console.log(`[draw] 初始视图：从 ${getFirstActionAt(ev)}ms 开始，显示最近 ${displayRangeMs.value}ms`);
          actualOffsetMs = getFirstActionAt(ev);
        } else {
          // 用户操作后（滚动或拖拽），使用 scrollOffsetMs 作为偏移量
          // 但需要确保 visible 数组与 offsetMs 和 displayRangeMs 匹配
          console.log(`[draw] 滚动视图：scrollOffsetMs=${scrollOffsetMs.value}, maxAt=${maxAt}, displayRangeMs=${displayRangeMs.value}`);
          
          // 计算实际偏移量（与 filteredActions 的 startMs 一致）
          const firstAt = getFirstActionAt(ev);
          actualOffsetMs = Math.max(firstAt, Math.min(scrollOffsetMs.value, maxAt - displayRangeMs.value));
        }
        
        console.log(`[draw] actualOffsetMs=${actualOffsetMs}, displayRangeMs=${displayRangeMs.value}`);
        
        // 只绘制当前视图范围内的节点，与表格保持一致
        const visible = filteredActions.value;
        // 将 dragIdx（全数组索引）转换为 filteredActions 中的索引，如果没有找到则保持原值
        let visDragIdx = -1;
        if (dragIdx >= 0 && ev) {
          const dragged = ev.actions[dragIdx];
          visDragIdx = visible.indexOf(dragged);
          console.log(`[draw] dragIdx=${dragIdx}, visDragIdx=${visDragIdx}, node: at=${dragged.at}, pos=${dragged.pos}`);
        } else {
          // 如果 dragIdx 不在 filtered 数组中，保持全数组索引传递给 Core.draw
          console.log(`[draw] dragIdx=${dragIdx} not in visible, keeping full index`);
        }
        
        // highlight：将全数组索引转换为 filteredActions 的索引（当前视图可见的节点）
        let visHighlightIdx = -1;
        if (highlightIdx.value >= 0 && highlightIdx.value < ev.actions.length) {
          const highlightedNode = ev.actions[highlightIdx.value];
          console.log(`[draw] highlightIdx=${highlightIdx.value}, highlighted node: at=${highlightedNode.at}, pos=${highlightedNode.pos}`);
          // 在 filteredActions 中查找该节点（使用 at+pos 匹配，因为对象引用可能变化）
          visHighlightIdx = visible.findIndex(a => 
            Math.abs((a.at || 0) - (highlightedNode.at || 0)) < 1 &&
            Math.abs((a.pos || 0) - (highlightedNode.pos || 0)) < 1
          );
          console.log(`[draw] visHighlightIdx=${visHighlightIdx}`);
        }
        
        // highlightAt/highlightPos：始终使用全数组索引对应的值（支持节点不在 visible 范围内）
        const highlightAt = ev.actions[highlightIdx.value]?.at;
        const highlightPos = ev.actions[highlightIdx.value]?.pos;
        
        Core.draw(ctx, canvas, visible, {
          dragIdx: visDragIdx >= 0 ? visDragIdx : dragIdx,  // 如果找不到则保持全数组索引
          dragAt: ev.actions[dragIdx]?.at,
          dragPos: ev.actions[dragIdx]?.pos,
          highlightIdx: visHighlightIdx,  // filteredActions 的索引（用于直接比较）
          highlightAt: highlightAt,        // 全数组的 at 值（用于 at+pos 匹配）
          highlightPos: highlightPos,      // 全数组的 pos 值
          playing: playing.value, playheadMs: playheadMs.value,
          isRightSelecting, selStartX, selStartY, selCurX, selCurY,
            vm: displayRangeMs.value,
            offsetMs: actualOffsetMs
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

    // ========== 缩放功能 ==========


    function onWheel(e) {
      // 始终阻止默认行为，防止页面滚动或 Canvas 缩放
      e.preventDefault();
      e.stopPropagation();
      console.log('onWheel called, ctrlKey:', e.ctrlKey, 'metaKey:', e.metaKey);
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+滚轮：缩放 Canvas
        console.log('[sandbox] zoom: ctrlKey=', e.ctrlKey, 'deltaY=', e.deltaY);

        const ev = activeEvent.value;
        if (!ev || !ev.actions.length) return;
        const maxAt = eventMaxAt(ev);

        // 滚轮灵敏度：5% 每步
        const zoomFactor = 1.05;
        const scaleDelta = e.deltaY > 0 ? zoomFactor : 1 / zoomFactor;
        const oldRange = displayRangeMs.value;
        let newRange = oldRange * scaleDelta;
        // 限制范围：最小 50ms ~ 总时长
        newRange = Math.max(50, Math.min(newRange, maxAt || 50));
        displayRangeMs.value = newRange;

        // 调整 scrollOffset，保持数据不超出范围
        const maxOffset = Math.max(0, maxAt - newRange);
        if (scrollOffsetMs.value > maxOffset) scrollOffsetMs.value = maxOffset;

        console.log('sandbox zoom: scaleDelta:', scaleDelta.toFixed(4), 'new range:', Math.round(newRange), 'offset:', Math.round(scrollOffsetMs.value));
        draw();
      } else {
        // 横向滚动（非 Ctrl 时滚轮滚动数据）
        e.preventDefault();
        const ev = activeEvent.value;
        if (!ev || !ev.actions.length) return;
        const maxAt = eventMaxAt(ev);
        const maxOffset = Math.max(0, maxAt - displayRangeMs.value);
        if (maxOffset <= 0) return;
        // 每次滚动 10% 的可见范围
        const scrollStep = displayRangeMs.value * 0.1;
        scrollOffsetMs.value = Math.max(0, Math.min(maxOffset, scrollOffsetMs.value + (e.deltaY > 0 ? scrollStep : -scrollStep)));
        draw();
      }
    }

    // 在 canvas 挂载后绑定事件
    onMounted(() => {
      const canvas = getCanvas();
      if (canvas) {
        canvas.onWheel = onWheel;
        // canvas.addEventListener('wheel', onWheel, { passive: false });
      }
    });

    function onTouchStart(e) {
      if (e.touches.length === 2) {
        isPinching = true;
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx1 = touch1.clientX - touch1.clientY;
        const dy1 = touch1.clientX + touch1.clientY;
        const dx2 = touch2.clientX - touch2.clientY;
        const dy2 = touch2.clientX + touch2.clientY;
        touchStartDist = Math.hypot(dx2 - dx1, dy2 - dy1);
        touchStartScale = lastScale.value;
      }
    }

    function onTouchMove(e) {
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

          // 直接修改 viewMs，基于当前值缩放
          viewMs.value *= scaleRatio;

          console.log('sandbox touch zoom: scaleRatio:', scaleRatio.toFixed(4), 'new viewMs:', Math.round(viewMs.value));

          draw();
        }
      }
    }

    function onTouchEnd(e) {
      if (e.touches.length < 2) {
        isPinching = false;
      }
    }

    watch([events, activeName], () => {
      // 切换事件时重置滚动位置到开头（最早的数据）
      const ev = activeEvent.value;
      if (ev && ev.actions.length) {
        // 默认显示从时间 0 开始，不自动滚动到末尾
        scrollOffsetMs.value = 0;
      } else {
        scrollOffsetMs.value = 0;
      }
      nextTick(draw);
    }, { deep: true });
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
      allowedHostsText, saveAllowedHosts, allowedHostsSaved,
      pickBackupFile, doBackup, onRestoreFile,
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
      displayRangeMs, filteredActions, applyViewRange,
      scrollOffsetMs, scrollBarVisible, scrollBarThumbWidth, scrollBarThumbLeft, onScrollBarMouseDown,
      addEvent, duplicateEvent, removeEvent, addAction, removeAction, sortDedupe, invert,
      funscriptJson, copyJson, downloadJson, importDialogVisible, importText, doImport, doImportAndSave, loadSample,
      pushToDevice, fmtDuration, editingId, editingName,
      // 画布编辑
      canvasRef, playing, onPointerDown, onPointerMove, onPointerUp, onContextMenu, togglePlay,
      onWheel, onTouchStart, onTouchMove, onTouchEnd, highlightIdx, onTableRowClick, origIdx,
      waveShapes, gen, appendWave,
      pulseDialogVisible, pulseText, pulseFileRef, pulseBreakFlat, pulseVariation, triggerPulseFile, onPulseFile, doImportPulse,
      actionsTableRef, selectedActions, rangeDelStart, rangeDelEnd,
      onSelectionChange, deleteSelected, clearAllActions, deleteByRange,
      onMainTabChange, saveZoomMin, zoomMinSaved,
      // 表格高亮样式方法（必须加入到 return 中才能被模板使用）
      highlightedRowClass
    };
  }
}).use(ElementPlus).mount('#app');
