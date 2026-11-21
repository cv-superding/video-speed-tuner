'use strict';

/* ------------------------------------------------------------------
 * Video Speed Pro - popup logic
 * ------------------------------------------------------------------ */

const MIN = 0.1;
const MAX = 16;
const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const ACTION_DEFS = [
  { id: 'faster', name: '加速' },
  { id: 'slower', name: '减速' },
  { id: 'finer', name: '微调 +1%' },
  { id: 'coarser', name: '微调 −1%' },
  { id: 'reset', name: '重置为 1×' },
  { id: 'toggleRate', name: '1× 来回切' },
  { id: 'presetNext', name: '下一档预设' },
  { id: 'back5', name: '后退 5 秒' },
  { id: 'fwd5', name: '前进 5 秒' },
  { id: 'toggleOverlay', name: '角标开关' },
  { id: 'toggleLock', name: '锁定开关' },
  { id: 'prevVideo', name: '上一个视频' },
  { id: 'nextVideo', name: '下一个视频' }
];

const ACTION_NAMES = {};
ACTION_DEFS.forEach((d) => { ACTION_NAMES[d.id] = d.name; });

const DEFAULT_KEYMAP = {
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
};

const $ = (id) => document.getElementById(id);
const LOG_RANGE = Math.log(MAX / MIN);

const EXT = typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD_META = IS_MAC ? 'Cmd' : 'Win';

/* --------------------------- rate helpers ------------------------ */

function posOf(rate) {
  const r = Math.min(MAX, Math.max(MIN, rate));
  return Math.round((Math.log(r / MIN) / LOG_RANGE) * 1000);
}

function rateOf(pos) {
  const r = MIN * Math.exp((pos / 1000) * LOG_RANGE);
  return Math.min(MAX, Math.max(MIN, Math.round(r * 100) / 100));
}

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100));
}

function fmt(v) {
  const n = Math.round(Number(v) * 100) / 100;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/0+$/, '');
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

/* ---------------------------- key labels ------------------------- */

const CODE_LABELS = {
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: '⌫', Delete: 'Del',
  Tab: 'Tab', CapsLock: 'Caps', ArrowUp: '↑', ArrowDown: '↓',
  ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', Backquote: '`'
};

function codeLabel(code) {
  if (!code) return '';
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

function bindingLabel(b) {
  if (!b || !b.code) return '';
  const parts = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  if (b.meta) parts.push(MOD_META);
  parts.push(codeLabel(b.code));
  return parts.join('+');
}

/* ------------------------------ state ---------------------------- */

let S = null;
let editing = false;
let recording = null;
let currentTab = 'speed';
let lastSentAt = 0;
let trailingTimer = null;
let trailingRate = null;

const curRate = () => (S ? S.rate : 1);
const curScope = () => (S ? S.scope : 'site');
const isOn = () => !S || S.enabled !== false;

/* ----------------------------- painting -------------------------- */

function markChips(rate) {
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('on', Math.abs(Number(c.dataset.rate) - rate) < 0.005);
  });
}

function paintFill(pos) {
  $('slider').style.setProperty('--fill', pos / 10 + '%');
}

function paintAll(rate) {
  const r = Math.round(rate * 100) / 100;
  const p = posOf(r);
  $('slider').value = String(p);
  paintFill(p);
  if (!editing) $('rateInput').value = fmt(r);
  markChips(r);
}

function paintSoft(rate, pos) {
  paintFill(pos);
  if (!editing) $('rateInput').value = fmt(rate);
  markChips(rate);
}

function paintScope() {
  document.querySelectorAll('#scopeSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.scope === curScope());
  });
}

function paintStep() {
  const step = S && S.step ? Number(S.step) : 0.1;
  document.querySelectorAll('#stepSeg button').forEach((b) => {
    b.classList.toggle('on', Math.abs(Number(b.dataset.step) - step) < 1e-6);
  });
}

/** 角标位置 / 角标缩放 / 面板缩放 */
function paintOverlayControls() {
  const opts = (S && S.opts) || {};
  const pos = opts.overlayPos || 'tr';
  const os = Number(opts.overlayScale) || 1;
  const ps = Number(opts.panelScale) || 1;

  document.querySelectorAll('#cornerPicker button').forEach((b) => {
    b.classList.toggle('on', b.dataset.pos === pos);
  });

  document.querySelectorAll('#overlayScaleSeg button').forEach((b) => {
    b.classList.toggle('on', Math.abs(Number(b.dataset.scale) - os) < 1e-6);
  });

  document.querySelectorAll('#panelScaleSeg button').forEach((b) => {
    b.classList.toggle('on', Math.abs(Number(b.dataset.scale) - ps) < 1e-6);
  });
}

function paintEnabled() {
  const enabled = isOn();
  const inactive = !enabled || !!(S && S.blocked);
  const app = document.querySelector('.app');
  app.classList.toggle('off', inactive);
  $('logo').src = inactive ? 'icons/icon48_disabled.png' : 'icons/icon48.png';
  $('enabled').checked = enabled;
}

function paintStatus() {
  const el = $('status');
  if (!S || !S.supported || !S.videos) {
    el.textContent = '';
    el.classList.remove('live');
    return;
  }
  const parts = [S.playing ? '播放中' : '暂停'];
  if (S.videos > 1) parts.push(S.videos + ' 个');
  if (S.duration > 0) parts.push(fmtClock(S.duration));
  el.textContent = parts.join(' · ');
  el.classList.toggle('live', !!S.playing);
}

function setTip(text, warn) {
  const el = $('keyTip');
  el.textContent = text;
  el.classList.toggle('warn', !!warn);
}

function updateHint() {
  if (!S || !S.supported) {
    $('hint').textContent = '请在普通网页中使用';
    return;
  }
  if (!isOn()) {
    $('hint').textContent = '扩展已停用';
    return;
  }
  if (S.blocked) {
    $('hint').textContent = '此站点已禁用';
    return;
  }
  if (currentTab === 'keys') $('hint').textContent = '快捷键在网页中生效';
  else if (currentTab === 'more') $('hint').textContent = '设置自动保存';
  else $('hint').textContent = 'Alt + . / , 可全局调速';
}

/* --------------------------- key painting ------------------------ */

function buildKeyList() {
  const wrap = $('keylist');
  wrap.textContent = '';
  ACTION_DEFS.forEach((def) => {
    const row = document.createElement('div');
    row.className = 'keyrow';

    const name = document.createElement('span');
    name.className = 'kname';
    name.textContent = def.name;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'keycap';
    btn.dataset.action = def.id;
    btn.textContent = '…';
    btn.addEventListener('click', () => {
      if (recording === def.id) stopRecording();
      else startRecording(def.id);
    });

    row.appendChild(name);
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}

function renderKeys() {
  const map = (S && S.keymap) || {};
  document.querySelectorAll('.keycap').forEach((btn) => {
    const action = btn.dataset.action;
    const label = bindingLabel(map[action]);
    btn.classList.toggle('empty', !label);
    btn.classList.toggle('recording', recording === action);
    btn.textContent = recording === action ? '按下…' : label || '未设置';
  });
}

function startRecording(action) {
  recording = action;
  renderKeys();
  setTip('现在按下组合键 · Esc 取消 · Backspace 清除', false);
}

function stopRecording() {
  recording = null;
  renderKeys();
  setTip('点按键格后按下组合键 · Esc 取消 · Backspace 清除', false);
}

async function saveBinding(action, binding) {
  if (!EXT) {
    S.keymap = S.keymap || {};
    if (binding) S.keymap[action] = binding;
    else delete S.keymap[action];
    renderKeys();
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'popup:setKeymap', action, binding });
    if (res && res.ok) {
      S.keymap = res.keymap;
      renderKeys();
    } else if (res && res.error === 'conflict') {
      setTip('与「' + (ACTION_NAMES[res.conflictWith] || res.conflictWith) + '」冲突，换一个组合', true);
      renderKeys();
    } else {
      setTip('保存失败，请重试', true);
      renderKeys();
    }
  } catch (e) {
    setTip('保存失败，请重试', true);
    renderKeys();
  }
}

async function renderSystemKeys() {
  const box = $('syslist');
  if (!EXT || !chrome.commands || !chrome.commands.getAll) {
    box.textContent = '加载为扩展后可见';
    return;
  }
  try {
    const list = await chrome.commands.getAll();
    box.textContent = '';
    list.forEach((cmd) => {
      if (!ACTION_NAMES[cmd.name]) return;
      const span = document.createElement('span');
      span.className = 'syskey' + (cmd.shortcut ? '' : ' none');
      span.textContent = cmd.name + ' ' + (cmd.shortcut || '未设置');
      box.appendChild(span);
    });
    if (!box.children.length) box.textContent = '读取不到快捷键';
  } catch (e) {
    box.textContent = '读取失败';
  }
}

/* ---------------------------- 站点列表 --------------------------- */

function paintSites() {
  const box = $('sites');
  box.textContent = '';

  const rates = (S && S.siteRates) || {};
  const blocked = (S && S.blocklist) || [];
  const hosts = Array.from(new Set(Object.keys(rates).concat(blocked))).sort();

  if (!hosts.length) {
    const empty = document.createElement('div');
    empty.className = 'site-empty';
    empty.textContent = '还没有记录，调速或禁用某个站点后会出现在这里';
    box.appendChild(empty);
    return;
  }

  hosts.forEach((host) => {
    const off = blocked.indexOf(host) >= 0;
    const rate = rates[host];

    const row = document.createElement('div');
    row.className = 'site';

    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = host;
    name.title = host;
    row.appendChild(name);

    if (off) {
      const tag = document.createElement('span');
      tag.className = 'site-tag';
      tag.textContent = '已禁用';
      row.appendChild(tag);
    } else if (typeof rate === 'number') {
      const r = document.createElement('span');
      r.className = 'site-rate';
      r.textContent = fmt(rate) + '×';
      row.appendChild(r);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'site-del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => removeHost(host));
    row.appendChild(del);

    box.appendChild(row);
  });
}

/** 当前站点的禁用按钮状态 */
function paintBlockButton() {
  const host = (S && S.host) || '';
  const off = !!(S && S.blocked);
  const btn = $('toggleBlock');
  const title = $('blockTitle');
  const sub = $('blockSub');

  if (!host) {
    title.textContent = '在本站禁用';
    sub.textContent = '当前页面不支持';
    btn.textContent = '禁用';
    btn.disabled = true;
    btn.classList.remove('on');
    return;
  }

  btn.disabled = false;
  title.textContent = host;

  if (off) {
    sub.textContent = '此站点已禁用，扩展完全不生效';
    btn.textContent = '启用';
    btn.classList.add('on');
  } else {
    sub.textContent = '禁用后扩展在此网站完全不生效';
    btn.textContent = '禁用';
    btn.classList.remove('on');
  }
}

async function removeHost(host) {
  if (!EXT) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'popup:removeHost', host });
    if (res && res.payload) {
      S = res.payload;
      paintSites();
      paintBlockButton();
    }
  } catch (e) { /* ignore */ }
}

/* ----------------------------- traffic --------------------------- */

async function sendOption(key, value) {
  if (!EXT) return;
  try {
    await chrome.runtime.sendMessage({ type: 'popup:setOption', key, value });
  } catch (e) { /* ignore */ }
}

async function doSend(rate) {
  if (!S) return;
  if (!EXT) {
    S.rate = rate;
    paintAll(S.rate);
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'popup:setRate',
      rate: rate,
      scope: curScope()
    });
    if (res && res.ok) {
      S.rate = res.rate;
      S.source = res.payload ? res.payload.source : S.source;
      paintAll(S.rate);
    }
  } catch (e) {
    /* service worker 正在唤醒，忽略 */
  }
}

function pushRate(rate) {
  trailingRate = rate;
  const now = Date.now();
  if (now - lastSentAt > 130) {
    lastSentAt = now;
    doSend(rate);
    return;
  }
  if (trailingTimer) return;
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    lastSentAt = Date.now();
    doSend(trailingRate);
  }, 130);
}

function applyLocal(rate) {
  const r = clamp(rate);
  if (!S) return;
  S.rate = r;
  paintAll(r);
  pushRate(r);
}

/* ------------------------------ wiring --------------------------- */

const TAB_ORDER = ['speed', 'keys', 'more'];

/** 内容超出时给底部加渐隐，提示还能往下滚 */
function updateScrollHint() {
  const panes = document.querySelector('.panes');
  if (!panes) return;
  const canScroll = panes.scrollHeight > panes.clientHeight + 2;
  const atBottom = panes.scrollTop + panes.clientHeight >= panes.scrollHeight - 4;
  panes.classList.toggle('scrollable', canScroll);
  panes.classList.toggle('at-bottom', atBottom);
}

function showTab(name) {
  currentTab = name;
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('on', p.id === 'pane-' + name);
  });

  const idx = TAB_ORDER.indexOf(name);
  const ink = $('tabInk');
  if (ink && idx >= 0) ink.style.transform = 'translateX(' + idx * 100 + '%)';

  const panes = document.querySelector('.panes');
  if (panes) panes.scrollTop = 0;

  updateHint();
  requestAnimationFrame(updateScrollHint);
}

function buildPresets() {
  const wrap = $('presets');
  wrap.textContent = '';
  PRESETS.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.rate = String(v);
    b.textContent = fmt(v) + '×';
    b.addEventListener('click', () => applyLocal(v));
    wrap.appendChild(b);
  });
}

function wire() {
  const stepOf = () => Number((S && S.step) || 0.1);

  const panesEl = document.querySelector('.panes');
  if (panesEl) panesEl.addEventListener('scroll', updateScrollHint, { passive: true });

  $('minus').addEventListener('click', () => applyLocal(curRate() - stepOf()));
  $('plus').addEventListener('click', () => applyLocal(curRate() + stepOf()));

  $('slider').addEventListener('input', () => {
    const p = Number($('slider').value);
    const r = rateOf(p);
    if (S) S.rate = r;
    paintSoft(r, p);
    pushRate(r);
  });

  $('slider').addEventListener('wheel', (e) => {
    e.preventDefault();
    applyLocal(curRate() + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: false });

  const input = $('rateInput');
  input.addEventListener('focus', () => {
    editing = true;
    input.select();
  });
  input.addEventListener('blur', () => {
    editing = false;
    const raw = parseFloat(String(input.value).replace(',', '.').replace(/[^\d.]/g, ''));
    applyLocal(Number.isFinite(raw) ? raw : curRate());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      editing = false;
      input.value = fmt(curRate());
      input.blur();
    }
  });

  document.querySelectorAll('#tabs button').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
  });

  document.querySelectorAll('#scopeSeg button').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!S) return;
      S.scope = b.dataset.scope;
      paintScope();
      await doSend(curRate());
    });
  });

  document.querySelectorAll('#stepSeg button').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!S) return;
      const step = Number(b.dataset.step);
      S.step = step;
      paintStep();
      await sendOption('step', step);
    });
  });

  // 角标位置：四宫格直接点
  document.querySelectorAll('#cornerPicker button').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!S) return;
      if (!S.opts) S.opts = {};
      S.opts.overlayPos = b.dataset.pos;
      paintOverlayControls();
      await sendOption('overlayPos', b.dataset.pos);
    });
  });

  // 角标 / 面板缩放
  [['overlayScaleSeg', 'overlayScale'], ['panelScaleSeg', 'panelScale']].forEach(([id, key]) => {
    document.querySelectorAll('#' + id + ' button').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!S) return;
        if (!S.opts) S.opts = {};
        const v = Number(b.dataset.scale);
        S.opts[key] = v;
        paintOverlayControls();
        await sendOption(key, v);
      });
    });
  });

  document.querySelectorAll('input[data-opt]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const key = cb.dataset.opt;
      const value = cb.checked;
      if (S && S.opts) S.opts[key] = value;
      if (S && key === 'badge') S.badge = value;
      await sendOption(key, value);
    });
  });

  $('enabled').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (S) S.enabled = on;
    paintEnabled();
    updateHint();
    await sendOption('enabled', on);
  });

  // ---- 快捷键录制 ----
  document.addEventListener('keydown', (e) => {
    if (!recording) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      stopRecording();
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      const action = recording;
      stopRecording();
      saveBinding(action, null);
      return;
    }

    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return;

    const action = recording;
    const binding = {
      code: e.code,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey
    };
    stopRecording();
    saveBinding(action, binding);
  }, true);

  $('resetKeys').addEventListener('click', async () => {
    if (!S) return;
    if (!EXT) {
      S.keymap = JSON.parse(JSON.stringify(DEFAULT_KEYMAP));
      renderKeys();
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: 'popup:resetKeys' });
      if (res && res.ok) {
        S.keymap = res.keymap;
        renderKeys();
      }
    } catch (e) { /* ignore */ }
  });

  $('openShortcuts').addEventListener('click', async () => {
    if (!EXT) return;
    const url = navigator.userAgent.includes('Edg/')
      ? 'edge://extensions/shortcuts'
      : 'chrome://extensions/shortcuts';
    try {
      await chrome.tabs.create({ url });
      window.close();
    } catch (e) {
      setTip('请手动打开 ' + url, true);
    }
  });

  $('clearSites').addEventListener('click', async () => {
    if (!EXT || !S) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'popup:clearSites' });
      if (res && res.payload) {
        S = res.payload;
        paintSites();
        paintBlockButton();
      }
    } catch (e) { /* ignore */ }
  });

  // 当前站点一键禁用 / 启用
  $('toggleBlock').addEventListener('click', async () => {
    if (!EXT || !S || !S.host) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'popup:toggleBlock', host: S.host });
      if (res && res.payload) {
        S = res.payload;
        render();
      }
    } catch (e) { /* ignore */ }
  });

  $('resetPanel').addEventListener('click', async () => {
    if (!EXT) return;
    try {
      await chrome.runtime.sendMessage({ type: 'popup:resetPanel' });
      setTip('面板位置已重置', false);
    } catch (e) { /* ignore */ }
  });

  // 重置：两段确认
  let armed = false;
  let armTimer = null;
  const resetBtn = $('resetAll');

  const disarm = () => {
    armed = false;
    clearTimeout(armTimer);
    resetBtn.classList.remove('armed');
    resetBtn.textContent = '重置全部';
  };

  resetBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      resetBtn.classList.add('armed');
      resetBtn.textContent = '确认重置？';
      armTimer = setTimeout(disarm, 2600);
      return;
    }
    disarm();
    if (!EXT) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'popup:resetAll' });
      if (res && res.payload) {
        S = res.payload;
        render();
      }
    } catch (e) { /* ignore */ }
  });
}

/* ------------------------------ render --------------------------- */

function render() {
  if (!S) return;

  try {
    const host = String(S.host || '').replace(/^www\./, '');
    $('host').textContent = host || (S.supported ? '当前页面' : '此页面不受支持');
    $('host').title = S.url || '';

    document.querySelector('.app').classList.toggle('unsupported', !S.supported);

  paintAll(S.rate);
  paintScope();
  paintStep();
  paintOverlayControls();
  paintEnabled();
  paintStatus();
  paintSites();
  paintBlockButton();
  renderKeys();
    renderSystemKeys();
    updateHint();

    if (S.opts) {
      document.querySelectorAll('input[data-opt]').forEach((cb) => {
        const key = cb.dataset.opt;
        if (key === 'badge') cb.checked = S.badge !== false;
        else cb.checked = !!S.opts[key];
      });
    }

    document.body.dataset.ready = '1';
    requestAnimationFrame(updateScrollHint);
  } catch (e) {
    // 渲染失败不该白屏，留下痕迹便于排查
    document.body.dataset.ready = '0';
    document.body.dataset.renderError = String((e && e.message) || e).slice(0, 200);
  }
}

/* --------------------------- runtime sync ------------------------ */

if (EXT) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'popup:stats' || !msg.payload || !S) return;
    S.videos = msg.payload.videos;
    S.playing = msg.payload.playing;
    S.duration = msg.payload.duration;
    S.currentTime = msg.payload.currentTime;
    paintStatus();
  });
}

/* ------------------------------- boot ---------------------------- */

function demoState() {
  return {
    tabId: -1,
    url: 'https://www.youtube.com/watch?v=demo',
    host: 'youtube.com',
    supported: true,
    enabled: true,
    blocked: false,
    blocklist: ['example.com'],
    badge: true,
    rate: 1.5,
    source: 'site',
    scope: 'site',
    globalRate: 1,
    siteRates: { 'youtube.com': 1.5, 'bilibili.com': 2, 'coursera.org': 1.25 },
    videos: 2,
    playing: true,
    duration: 634,
    currentTime: 125,
    opts: {
      autoApply: true, lock: false,
      overlay: true, overlayPos: 'tr', overlayScale: 1,
      panel: true, panelScale: 1, keysEnabled: true
    },
    step: 0.1,
    keymap: JSON.parse(JSON.stringify(DEFAULT_KEYMAP))
  };
}

/** service worker 冷启动时首条消息可能失败，重试几次 */
async function fetchInit(retries) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'popup:init' });
      if (res && typeof res === 'object' && 'rate' in res) return res;
    } catch (e) {
      /* 后台还没醒，等一会儿再试 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

(async function boot() {
  buildPresets();
  buildKeyList();
  wire();

  if (location.hash === '#keys') showTab('keys');
  if (location.hash === '#more') showTab('more');

  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    showTab(h === 'keys' || h === 'more' ? h : 'speed');
  });

  if (!EXT) {
    S = demoState();
    render();
    return;
  }

  S = await fetchInit(8);

  if (!S) {
    $('host').textContent = '后台未响应，请重开扩展';
    return;
  }

  render();
})();
