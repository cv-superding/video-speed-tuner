'use strict';

/* ------------------------------------------------------------------
 * Video Speed Pro - background service worker
 * 设置的唯一真源：content script 与 popup 只做展示。
 * 全部逻辑本地完成，不发任何网络请求。
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  globalRate: 1,
  enabled: true,          // 扩展总开关（关闭时全部恢复 1x、图标变灰）
  badge: true,            // 在工具栏图标上显示速度徽标
  scope: 'site',          // 'tab' | 'site' | 'global'
  siteRates: {},          // host -> rate
  blocklist: [],          // 在这些站点上完全不生效（支持子域匹配）
  autoApply: true,        // 新视频自动套用记忆速度
  lock: false,            // 强力锁定，阻止网站改回速度
  overlay: true,          // 改速度时右上角提示
  overlayPos: 'tr',       // 角标位置：tl / tr / bl / br
  overlayScale: 1,        // 角标缩放：0.85 / 1 / 1.2
  panel: true,            // 页面内浮动控制面板
  panelScale: 1,          // 面板缩放：0.85 / 1 / 1.2
  step: 0.1,              // 粗调步长
  keysEnabled: false,     // 页面内快捷键总开关
  keymap: {
    // 默认与前版保持一致：A 加速 / D 减速 / S 重置，Shift 组合做 1% 微调
    faster: { code: 'KeyA', ctrl: false, alt: false, shift: false, meta: false },
    slower: { code: 'KeyD', ctrl: false, alt: false, shift: false, meta: false },
    finer: { code: 'KeyA', ctrl: false, alt: false, shift: true, meta: false },
    coarser: { code: 'KeyD', ctrl: false, alt: false, shift: true, meta: false },
    reset: { code: 'KeyS', ctrl: false, alt: false, shift: false, meta: false },
    toggleRate: { code: 'KeyQ', ctrl: false, alt: false, shift: false, meta: false },
    presetNext: { code: 'KeyP', ctrl: false, alt: false, shift: false, meta: false },
    back5: { code: 'KeyZ', ctrl: false, alt: false, shift: false, meta: false },
    fwd5: { code: 'KeyX', ctrl: false, alt: false, shift: false, meta: false },
    toggleOverlay: { code: 'KeyH', ctrl: false, alt: false, shift: false, meta: false },
    toggleLock: { code: 'KeyL', ctrl: false, alt: false, shift: false, meta: false },
    prevVideo: { code: 'BracketLeft', ctrl: false, alt: false, shift: false, meta: false },
    nextVideo: { code: 'BracketRight', ctrl: false, alt: false, shift: false, meta: false }
  }
};

const KEY_ACTIONS = [
  'faster', 'slower', 'finer', 'coarser', 'reset', 'toggleRate', 'presetNext',
  'back5', 'fwd5', 'toggleOverlay', 'toggleLock', 'prevVideo', 'nextVideo'
];

const BOOL_OPTIONS = ['autoApply', 'lock', 'overlay', 'panel', 'keysEnabled', 'enabled', 'badge'];
const STEP_VALUES = [0.01, 0.05, 0.1, 0.25];
const POS_VALUES = ['tl', 'tr', 'bl', 'br'];
const SCALE_VALUES = [0.85, 1, 1.2];
const PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8];

const MIN_RATE = 0.1;
const MAX_RATE = 16;

const ICONS_ON = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png'
};
const ICONS_OFF = {
  16: 'icons/icon16_disabled.png',
  32: 'icons/icon32_disabled.png',
  48: 'icons/icon48_disabled.png',
  128: 'icons/icon128_disabled.png'
};

/** tabId -> Map<frameId, entry>
 *  entry = { port, tabId, frameId, url, videos, playing }
 */
const frames = new Map();

/* ---------------------------- helpers ---------------------------- */

function clampRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(n * 100) / 100));
}

function safeHost(url) {
  try {
    return new URL(url).hostname || '';
  } catch (e) {
    return '';
  }
}

/** 归一化成可比对的域名：去协议、去端口、去 www.、小写 */
function normalizeHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';

  if (s.includes('://')) {
    try {
      s = new URL(s).hostname;
    } catch (e) {
      return '';
    }
  } else {
    s = s.split('/')[0].split('?')[0].split('#')[0].replace(/:\d+$/, '');
  }

  s = s.replace(/^www\./, '');
  if (!s.includes('.') || !/^[a-z0-9.-]+$/.test(s)) return '';
  return s;
}

/** 域名或它的子域命中即算禁用 */
function isBlocked(host, list) {
  const h = normalizeHost(host);
  if (!h || !Array.isArray(list) || !list.length) return false;
  return list.some((entry) => {
    const e = normalizeHost(entry);
    if (!e) return false;
    return h === e || h.endsWith('.' + e);
  });
}

/**
 * 读设置。
 * 注意：不能用 chrome.storage.local.get(DEFAULTS) —— 它对对象型默认值做的是
 * 浅合并，会导致「被删掉的 keymap 项又从默认值里冒回来」。这里整键读取后自己补默认。
 */
async function readLocal() {
  let raw = {};
  try {
    raw = (await chrome.storage.local.get(null)) || {};
  } catch (e) {
    raw = {};
  }

  const out = Object.assign({}, DEFAULTS);

  if (typeof raw.globalRate === 'number') out.globalRate = raw.globalRate;
  if (raw.scope === 'tab' || raw.scope === 'site' || raw.scope === 'global') out.scope = raw.scope;
  if (raw.siteRates && typeof raw.siteRates === 'object') out.siteRates = raw.siteRates;
  if (Array.isArray(raw.blocklist)) {
    const seen = Object.create(null);
    out.blocklist = raw.blocklist
      .map(normalizeHost)
      .filter((h) => h && !seen[h] && (seen[h] = 1));
  }
  if (STEP_VALUES.includes(raw.step)) out.step = raw.step;
  if (POS_VALUES.includes(raw.overlayPos)) out.overlayPos = raw.overlayPos;
  if (SCALE_VALUES.includes(raw.overlayScale)) out.overlayScale = raw.overlayScale;
  if (SCALE_VALUES.includes(raw.panelScale)) out.panelScale = raw.panelScale;

  BOOL_OPTIONS.forEach((k) => {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  });

  // keymap 整体存在就按原样解释（缺哪个 action 就是没绑定），只有从未设置过才用默认
  out.keymap = raw.keymap && typeof raw.keymap === 'object'
    ? cloneKeymap(raw.keymap)
    : cloneKeymap(DEFAULTS.keymap);

  return out;
}

async function readTabRates() {
  try {
    const got = await chrome.storage.session.get({ tabRates: {} });
    return got.tabRates || {};
  } catch (e) {
    return {};
  }
}

async function writeTabRates(map) {
  try {
    await chrome.storage.session.set({ tabRates: map });
  } catch (e) {
    /* session 不可用时静默降级 */
  }
}

/** 只接受白名单字段，避免 content script 收到脏数据 */
function sanitizeBinding(b) {
  if (!b || typeof b !== 'object' || typeof b.code !== 'string' || !b.code) return null;
  return { code: b.code, ctrl: !!b.ctrl, alt: !!b.alt, shift: !!b.shift, meta: !!b.meta };
}

function sameBinding(a, b) {
  return !!a && !!b && a.code === b.code &&
    !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift && !!a.meta === !!b.meta;
}

function cloneKeymap(src) {
  const out = {};
  KEY_ACTIONS.forEach((name) => {
    const b = sanitizeBinding(src && src[name]);
    if (b) out[name] = b;
  });
  return out;
}

/** 解析某个 tab 当前应该用的速度：tab 覆盖 > 站点覆盖 > 全局 */
function resolveRate(state, tabId, url) {
  const host = safeHost(url);
  const tabRate = state.tabRates[String(tabId)];
  if (typeof tabRate === 'number') {
    return { rate: tabRate, source: 'tab', host };
  }
  if (host && typeof state.siteRates[host] === 'number') {
    return { rate: state.siteRates[host], source: 'site', host };
  }
  return { rate: state.globalRate, source: 'global', host };
}

async function fullState() {
  const local = await readLocal();
  const tabRates = await readTabRates();
  return Object.assign({}, local, { tabRates });
}

/* --------------------------- 广播状态 ---------------------------- */

function stateMessage(state, entry) {
  const r = resolveRate(state, entry.tabId, entry.url);
  const blocked = isBlocked(r.host, state.blocklist);
  return {
    type: 'state',
    // 总开关关闭或站点被排除时一律给 1x
    rate: state.enabled && !blocked ? r.rate : 1,
    enabled: state.enabled,
    blocked,
    source: r.source,
    scope: state.scope,
    opts: {
      enabled: state.enabled,
      autoApply: state.autoApply,
      lock: state.lock,
      overlay: state.overlay,
      overlayPos: state.overlayPos,
      overlayScale: state.overlayScale,
      panel: state.panel,
      panelScale: state.panelScale,
      step: state.step,
      keysEnabled: state.keysEnabled,
      keymap: state.keymap
    },
    presets: PRESETS
  };
}

/** 徽标文案：与原版一样保留 4 个字符，1x 时留空不干扰 */
function formatBadge(rate) {
  const s = Number(rate).toFixed(2).slice(0, 4);
  return s === '1.00' ? '' : s;
}

async function updateBadges() {
  if (!chrome.action) return;
  const state = await fullState();

  try {
    await chrome.action.setIcon({ path: state.enabled ? ICONS_ON : ICONS_OFF });
  } catch (e) { /* ignore */ }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    tabs = [];
  }

  for (const t of tabs) {
    if (t.id == null) continue;
    let text = '';
    if (state.enabled && state.badge) {
      const r = resolveRate(state, t.id, t.url || '');
      // 被排除的站点不显示徽标
      if (!isBlocked(r.host, state.blocklist)) text = formatBadge(r.rate);
    }
    try {
      await chrome.action.setBadgeText({ text, tabId: t.id });
      if (text) {
        await chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId: t.id });
      }
    } catch (e) { /* ignore */ }
  }
}

async function broadcast() {
  const state = await fullState();
  for (const bucket of frames.values()) {
    for (const [frameId, entry] of bucket) {
      try {
        entry.port.postMessage(stateMessage(state, entry));
      } catch (e) {
        bucket.delete(frameId);
      }
    }
  }
  updateBadges();
  notifyPopup();
}

async function notifyPopup() {
  try {
    const payload = await buildPopupState();
    await chrome.runtime.sendMessage({ type: 'popup:stats', payload });
  } catch (e) {
    /* 没有 popup 打开时会抛错，忽略 */
  }
}

/* --------------------------- 写入速度 ---------------------------- */

async function changeRate(tabId, url, rate, scope) {
  const r = clampRate(rate);
  const host = safeHost(url);
  const local = await readLocal();
  const tabRates = await readTabRates();
  const siteRates = Object.assign({}, local.siteRates);

  const patch = {};
  const tabKey = String(tabId);

  // 任何一次显式改动都先清掉本 tab 的临时覆盖，避免旧值压住新设置
  delete tabRates[tabKey];

  let finalScope = scope;
  if (scope === 'keep') finalScope = local.scope;

  if (finalScope === 'tab') {
    tabRates[tabKey] = r;
  } else if (finalScope === 'site') {
    if (host) siteRates[host] = r;
  } else {
    patch.globalRate = r;
    if (host) delete siteRates[host];
  }

  patch.siteRates = siteRates;
  if (finalScope !== 'keep') patch.scope = finalScope;

  await chrome.storage.local.set(patch);
  await writeTabRates(tabRates);
  return r;
}

/* ------------------------- popup 状态组装 ------------------------ */

async function activeTab() {
  try {
    const list = await chrome.tabs.query({ active: true, currentWindow: true });
    return list && list[0] ? list[0] : null;
  } catch (e) {
    return null;
  }
}

async function buildPopupState() {
  const local = await readLocal();
  const tabRates = await readTabRates();
  const state = Object.assign({}, local, { tabRates });
  const tab = await activeTab();

  let videos = 0;
  let playing = false;
  let duration = 0;
  let currentTime = 0;
  if (tab) {
    const bucket = frames.get(tab.id);
    if (bucket) {
      for (const entry of bucket.values()) {
        videos += entry.videos || 0;
        playing = playing || !!entry.playing;
        if ((entry.duration || 0) > duration) {
          duration = entry.duration;
          currentTime = entry.currentTime || 0;
        }
      }
    }
  }

  const r = tab
    ? resolveRate(state, tab.id, tab.url || '')
    : { rate: local.globalRate, source: 'global', host: '' };

  const url = tab ? tab.url || '' : '';
  const blocked = isBlocked(r.host, local.blocklist);
  return {
    tabId: tab ? tab.id : null,
    url,
    host: tab ? safeHost(url) : '',
    supported: /^https?:|^file:/i.test(url),
    enabled: local.enabled,
    blocked,
    blocklist: local.blocklist,
    badge: local.badge,
    rate: local.enabled && !blocked ? r.rate : 1,
    source: r.source,
    scope: local.scope,
    globalRate: local.globalRate,
    siteRates: local.siteRates,
    videos,
    playing,
    duration,
    currentTime,
    opts: {
      autoApply: local.autoApply,
      lock: local.lock,
      overlay: local.overlay,
      overlayPos: local.overlayPos,
      overlayScale: local.overlayScale,
      panel: local.panel,
      panelScale: local.panelScale,
      keysEnabled: local.keysEnabled
    },
    step: local.step,
    keymap: cloneKeymap(local.keymap),
    // 供 popup 校验后台是否是最新版本（新增动作时能立刻暴露「扩展未刷新」）
    keyActions: KEY_ACTIONS.slice(),
    presets: PRESETS
  };
}

/* ---------------------------- 端口 ------------------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vsp') return;

  const tab = port.sender && port.sender.tab;
  if (!tab || tab.id == null) return;

  const tabId = tab.id;
  const frameId = port.sender.frameId || 0;

  const entry = {
    port,
    tabId,
    frameId,
    url: port.sender.url || tab.url || '',
    videos: 0,
    playing: false,
    duration: 0,
    currentTime: 0
  };

  let bucket = frames.get(tabId);
  if (!bucket) {
    bucket = new Map();
    frames.set(tabId, bucket);
  }
  bucket.set(frameId, entry);

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    const b = frames.get(tabId);
    if (!b) return;
    b.delete(frameId);
    if (!b.size) frames.delete(tabId);
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      if (msg.url) entry.url = msg.url;
      const state = await fullState();
      try {
        port.postMessage(stateMessage(state, entry));
      } catch (e) { /* gone */ }
      return;
    }

    if (msg.type === 'stats') {
      entry.videos = Number(msg.videos) || 0;
      entry.playing = !!msg.playing;
      entry.duration = Number(msg.duration) || 0;
      entry.currentTime = Number(msg.currentTime) || 0;
      notifyPopup();
      return;
    }

    if (msg.type === 'setRate') {
      await changeRate(tabId, entry.url, msg.rate, msg.scope || 'keep');
      return;
    }

    if (msg.type === 'ping') return;
  });
});

/* ---------------------------- 消息 ------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  (async () => {
    try {
      if (msg.type === 'popup:init') {
        sendResponse(await buildPopupState());
        return;
      }

      if (msg.type === 'popup:setRate') {
        const tab = await activeTab();
        if (!tab) {
          sendResponse({ ok: false, error: 'no-tab' });
          return;
        }
        const r = await changeRate(tab.id, tab.url || '', msg.rate, msg.scope);
        sendResponse({ ok: true, rate: r, payload: await buildPopupState() });
        return;
      }

      if (msg.type === 'popup:setOption') {
        if (BOOL_OPTIONS.includes(msg.key)) {
          await chrome.storage.local.set({ [msg.key]: !!msg.value });
          sendResponse({ ok: true });
          return;
        }
        if (msg.key === 'step') {
          const s = Number(msg.value);
          if (!STEP_VALUES.includes(s)) {
            sendResponse({ ok: false, error: 'bad-step' });
            return;
          }
          await chrome.storage.local.set({ step: s });
          sendResponse({ ok: true });
          return;
        }
        if (msg.key === 'overlayPos') {
          if (!POS_VALUES.includes(msg.value)) {
            sendResponse({ ok: false, error: 'bad-pos' });
            return;
          }
          await chrome.storage.local.set({ overlayPos: msg.value });
          sendResponse({ ok: true });
          return;
        }
        if (msg.key === 'overlayScale' || msg.key === 'panelScale') {
          const v = Number(msg.value);
          if (!SCALE_VALUES.includes(v)) {
            sendResponse({ ok: false, error: 'bad-scale' });
            return;
          }
          await chrome.storage.local.set({ [msg.key]: v });
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, error: 'bad-key' });
        return;
      }

      if (msg.type === 'popup:setKeymap') {
        if (!KEY_ACTIONS.includes(msg.action)) {
          sendResponse({ ok: false, error: 'bad-action' });
          return;
        }

        const local = await readLocal();
        const keymap = cloneKeymap(local.keymap);

        if (msg.binding === null) {
          delete keymap[msg.action];
        } else {
          const binding = sanitizeBinding(msg.binding);
          if (!binding) {
            sendResponse({ ok: false, error: 'bad-binding' });
            return;
          }
          const clash = KEY_ACTIONS.find((name) => name !== msg.action && sameBinding(keymap[name], binding));
          if (clash) {
            sendResponse({ ok: false, error: 'conflict', conflictWith: clash });
            return;
          }
          keymap[msg.action] = binding;
        }

        await chrome.storage.local.set({ keymap });
        sendResponse({ ok: true, keymap });
        return;
      }

      if (msg.type === 'popup:resetKeys') {
        const keymap = cloneKeymap(DEFAULTS.keymap);
        await chrome.storage.local.set({ keymap });
        sendResponse({ ok: true, keymap });
        return;
      }

      if (msg.type === 'popup:removeSite') {
        const local = await readLocal();
        const siteRates = Object.assign({}, local.siteRates);
        if (msg.host && Object.prototype.hasOwnProperty.call(siteRates, msg.host)) {
          delete siteRates[msg.host];
          await chrome.storage.local.set({ siteRates });
        }
        sendResponse({ ok: true, payload: await buildPopupState() });
        return;
      }

      if (msg.type === 'popup:clearSites') {
        await chrome.storage.local.set({ siteRates: {}, blocklist: [] });
        sendResponse({ ok: true, payload: await buildPopupState() });
        return;
      }

      if (msg.type === 'popup:removeHost') {
        const host = normalizeHost(msg.host);
        if (!host) {
          sendResponse({ ok: false, error: 'bad-host' });
          return;
        }
        const local = await readLocal();
        const siteRates = Object.assign({}, local.siteRates);
        delete siteRates[host];
        const blocklist = local.blocklist.filter((h) => h !== host);
        await chrome.storage.local.set({ siteRates, blocklist });
        sendResponse({ ok: true, payload: await buildPopupState() });
        return;
      }

      if (msg.type === 'popup:toggleBlock') {
        const host = normalizeHost(msg.host);
        if (!host) {
          sendResponse({ ok: false, error: 'bad-host' });
          return;
        }
        const local = await readLocal();
        let list = local.blocklist.slice();
        const covered = isBlocked(host, list);

        if (covered) {
          // 删掉覆盖当前域名的那一条（可能是父域规则）
          list = list.filter((h) => !(host === h || host.endsWith('.' + h)));
        } else {
          list.push(host);
        }

        await chrome.storage.local.set({ blocklist: list });
        sendResponse({ ok: true, payload: await buildPopupState() });
        return;
      }

      if (msg.type === 'popup:removeBlock') {
        const host = normalizeHost(msg.host);
        if (!host) {
          sendResponse({ ok: false, error: 'bad-host' });
          return;
        }
        const local = await readLocal();
        const list = local.blocklist.filter((h) => h !== host);
        await chrome.storage.local.set({ blocklist: list });
        sendResponse({ ok: true, payload: await buildPopupState() });
        return;
      }

      if (msg.type === 'popup:resetPanel') {
        await chrome.storage.local.remove('panelPos');
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'popup:resetAll') {
        await chrome.storage.local.set({
          globalRate: DEFAULTS.globalRate,
          enabled: DEFAULTS.enabled,
          badge: DEFAULTS.badge,
          scope: DEFAULTS.scope,
          siteRates: {},
          blocklist: [],
          autoApply: DEFAULTS.autoApply,
          lock: DEFAULTS.lock,
          overlay: DEFAULTS.overlay,
          overlayPos: DEFAULTS.overlayPos,
          overlayScale: DEFAULTS.overlayScale,
          panel: DEFAULTS.panel,
          panelScale: DEFAULTS.panelScale,
          step: DEFAULTS.step,
          keysEnabled: DEFAULTS.keysEnabled,
          keymap: cloneKeymap(DEFAULTS.keymap)
        });
        await chrome.storage.local.remove('panelPos');
        await writeTabRates({});
        sendResponse({ ok: true, payload: await buildPopupState() });
        return;
      }

      sendResponse({ ok: false, error: 'unknown' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();

  return true; // 异步响应
});

/* --------------------------- 快捷键 ------------------------------ */

chrome.commands.onCommand.addListener(async (cmd) => {
  const tab = await activeTab();
  if (!tab) return;
  const state = await fullState();
  const r = resolveRate(state, tab.id, tab.url || '');
  if (isBlocked(r.host, state.blocklist)) return;
  const cur = r.rate;

  let next = cur;
  if (cmd === 'faster') next = cur + state.step;
  else if (cmd === 'slower') next = cur - state.step;
  else if (cmd === 'reset') next = 1;

  if (Math.abs(next - cur) < 0.0005) return;
  await changeRate(tab.id, tab.url || '', next, 'keep');
});

/* --------------------------- 右键菜单 ---------------------------- */

function buildMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    const mk = (id, title) => {
      try {
        chrome.contextMenus.create({ id, title, contexts: ['video'] });
      } catch (e) { /* ignore */ }
    };
    mk('vsp:faster', '加速');
    mk('vsp:slower', '减速');
    mk('vsp:reset', '重置为 1×');
    try {
      chrome.contextMenus.create({ id: 'vsp:sep', type: 'separator', contexts: ['video'] });
    } catch (e) { /* ignore */ }
    mk('vsp:1.5', '1.5×');
    mk('vsp:2', '2×');
    mk('vsp:3', '3×');
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id == null) return;
    const state = await fullState();
    const resolved = resolveRate(state, tab.id, tab.url || '');
    // 被排除的站点上一律不响应右键菜单
    if (!state.enabled || isBlocked(resolved.host, state.blocklist)) return;
    const cur = resolved.rate;

    let next = null;
    if (info.menuItemId === 'vsp:faster') next = cur + state.step;
    else if (info.menuItemId === 'vsp:slower') next = cur - state.step;
    else if (info.menuItemId === 'vsp:reset') next = 1;
    else if (info.menuItemId === 'vsp:1.5') next = 1.5;
    else if (info.menuItemId === 'vsp:2') next = 2;
    else if (info.menuItemId === 'vsp:3') next = 3;

    if (next === null) return;
    await changeRate(tab.id, tab.url || '', next, 'keep');
  });
}

/* --------------------------- 生命周期 ---------------------------- */

chrome.tabs.onRemoved.addListener(async (tabId) => {
  frames.delete(tabId);
  const tabRates = await readTabRates();
  if (tabRates[String(tabId)] != null) {
    delete tabRates[String(tabId)];
    await writeTabRates(tabRates);
  }
});

// 同一 tab 导航到新页面时，丢弃它的「仅本页」临时速度
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading' && info.url) {
    const tabRates = await readTabRates();
    if (tabRates[String(tabId)] != null) {
      delete tabRates[String(tabId)];
      await writeTabRates(tabRates);
    }
  }
  updateBadges();
});

chrome.tabs.onActivated.addListener(() => updateBadges());

// 任何存储变化都重新广播（tabRates 在 session，其余在 local）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || area === 'session') broadcast();
});

// service worker 冷启动时把徽标补上
updateBadges();
