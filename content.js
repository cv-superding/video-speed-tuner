'use strict';

/* ------------------------------------------------------------------
 * Video Speed Pro - content script
 * 注入到所有 frame，把速度套到页面里的 HTML5 媒体元素上。
 * 不读取页面内容，不上报任何数据。
 * ------------------------------------------------------------------ */

(function () {
  if (window.__VSP_CONTENT__) return;
  window.__VSP_CONTENT__ = true;

  const MIN = 0.1;
  const MAX = 16;
  const DEFAULT_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8];
  const ROOT_FRAME = window.top === window;

  let target = 1;
  let presets = DEFAULT_PRESETS;
  let opts = {
    autoApply: true, lock: false, overlay: true,
    overlayPos: 'tr', overlayScale: 1,
    panel: true, panelScale: 1,
    step: 0.1, keysEnabled: false, keymap: {}
  };
  let focusIndex = -1;
  let blockedHere = false;   // 当前站点被用户排除
  let port = null;
  let reconnectTimer = null;
  let initialized = false;

  const setting = new WeakSet();

  /* ------------------------- 媒体元素同步 ------------------------- */

  const isMedia = (el) => !!el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO');

  function mediaList() {
    try {
      return Array.prototype.slice.call(document.querySelectorAll('video,audio'));
    } catch (e) {
      return [];
    }
  }

  /** 当前受控的媒体集合：focusIndex >= 0 时只控制被选中的那一个 */
  function targetList() {
    const list = mediaList();
    if (focusIndex < 0) return list;
    if (focusIndex >= list.length) {
      focusIndex = -1;
      return list;
    }
    return [list[focusIndex]];
  }

  function applyTo(m, rate) {
    if (!isMedia(m)) return;
    try {
      // 变速不变调
      if ('preservesPitch' in m) m.preservesPitch = true;
      else if ('webkitPreservesPitch' in m) m.webkitPreservesPitch = true;

      if (Math.abs((m.playbackRate || 1) - rate) < 0.0005) return;

      setting.add(m);
      m.playbackRate = rate;
      setTimeout(() => setting.delete(m), 40);
    } catch (e) {
      /* 受保护的播放器不允许改，忽略 */
    }
  }

  /** 用户明确下达速度指令：无视当前值，全部强制套用 */
  function forceApply() {
    targetList().forEach((m) => applyTo(m, target));
  }

  /** 温和同步：只修正被网站重置回 1x 的播放器 */
  function softSync() {
    if (blockedHere) return;
    targetList().forEach((m) => {
      if (opts.lock) {
        applyTo(m, target);
        return;
      }
      if (!opts.autoApply) return;
      const cur = m.playbackRate || 1;
      if (Math.abs(cur - 1) < 0.0005 && Math.abs(target - 1) > 0.0005) {
        applyTo(m, target);
      }
    });
  }

  function clampRate(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100));
  }

  function fmt(v) {
    const n = Math.round(Number(v) * 100) / 100;
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2).replace(/0+$/, '');
  }

  /* ---------------------------- 动作实现 --------------------------- */

  function persistRate(rate) {
    if (!port) return;
    try {
      port.postMessage({ type: 'setRate', rate, scope: 'keep' });
    } catch (e) { /* gone */ }
  }

  function setRateValue(v, silent) {
    const next = clampRate(v);
    if (Math.abs(next - target) < 0.0005) return false;
    target = next;
    forceApply();
    updatePanel();
    if (!silent) showToast(fmt(next) + '×');
    persistRate(next);
    return true;
  }

  /**
   * 1× 来回切：当前不是 1× 就记住它并切到 1×，反之回到记住的那个速度。
   *
   * 两个刻意的设计：
   * 1. 记忆只放本页内存，不写 storage —— 每按一次都写会触发全量广播和徽标刷新。
   * 2. 落库一律用 scope='tab'，只影响当前标签页，不覆盖站点记忆。
   *    否则临时切一下 1×，下次访问该站就永久变成 1× 了。
   */
  let lastNonOne = 0;

  function toggleOne() {
    const go = (next) => {
      target = next;
      forceApply();
      updatePanel();
      showToast(fmt(next) + '×');
      if (port) {
        try {
          port.postMessage({ type: 'setRate', rate: next, scope: 'tab' });
        } catch (e) { /* gone */ }
      }
    };

    if (Math.abs(target - 1) > 0.0005) {
      lastNonOne = target;
      go(1);
      return;
    }
    // 还没记过就退到一个常用的加速档，避免按了没反应
    const back = lastNonOne > 0 && Math.abs(lastNonOne - 1) > 0.0005 ? lastNonOne : 1.5;
    go(back);
  }

  function nextPreset(cur) {
    const list = (presets && presets.length ? presets : DEFAULT_PRESETS).slice().sort((a, b) => a - b);
    for (const p of list) {
      if (p > cur + 0.0005) return p;
    }
    return list[0];
  }

  function seekBy(delta) {
    const list = targetList();
    const m = list.find((x) => !x.paused && !x.ended) || list[0];
    if (!m) {
      showToast('没有视频');
      return;
    }
    try {
      const dur = Number.isFinite(m.duration) ? m.duration : m.currentTime + Math.abs(delta) + 1;
      m.currentTime = Math.max(0, Math.min(dur, m.currentTime + delta));
      showToast((delta > 0 ? '+' : '') + delta + 's');
    } catch (e) { /* ignore */ }
  }

  function toggleOption(key) {
    const next = !opts[key];
    opts[key] = next;
    try {
      chrome.storage.local.set({ [key]: next });
    } catch (e) { /* ignore */ }

    if (key === 'overlay' && !next) hideToast();
    if (key === 'panel') {
      if (next) {
        panelHidden = false;
        showPanel();
        updatePanel();
        showToast('面板已开启');
      } else {
        hidePanel();
        showToast('面板已关闭');
      }
      return;
    }
    showToast(next ? '已开启' : '已关闭');
  }

  function cycleVideo(dir) {
    const list = mediaList();
    if (list.length < 2) {
      showToast('只有一个视频');
      return;
    }
    if (focusIndex < 0) focusIndex = dir > 0 ? 0 : list.length - 1;
    else focusIndex = (focusIndex + dir + list.length) % list.length;

    forceApply();
    updatePanel();
    showToast('视频 ' + (focusIndex + 1) + '/' + list.length);
  }

  function runAction(action) {
    if (opts.enabled === false) return;
    if (blockedHere) return;
    switch (action) {
      case 'faster': setRateValue(target + (opts.step || 0.1)); break;
      case 'slower': setRateValue(target - (opts.step || 0.1)); break;
      case 'finer': setRateValue(target + 0.01); break;
      case 'coarser': setRateValue(target - 0.01); break;
      case 'reset': setRateValue(1); break;
      case 'toggleRate': toggleOne(); break;
      case 'presetNext': setRateValue(nextPreset(target)); break;
      case 'back5': seekBy(-5); break;
      case 'fwd5': seekBy(5); break;
      case 'toggleOverlay': toggleOption('overlay'); break;
      case 'toggleLock': toggleOption('lock'); break;
      case 'prevVideo': cycleVideo(-1); break;
      case 'nextVideo': cycleVideo(1); break;
      default: break;
    }
  }

  /* --------------------------- 视觉层 ------------------------------ */

  let uiHost = null;
  let uiRoot = null;
  let toastWrap = null;
  let toastEl = null;
  let toastTimer = null;

  let panelWrap = null;
  let panelEl = null;
  let panelHidden = false;
  let panelHideTimer = null;
  let panelPos = null;     // { x, y } 相对视口
  let panelDragging = false;
  let panelScale = 1;

  const CSS = `
    :host { all: initial; }

    /* 定位与缩放在外层包裹，入场动画在内层，两者互不干扰 */
    .toast-wrap {
      position: fixed;
      pointer-events: none;
      transform: scale(var(--ts, 1));
    }
    .toast-wrap[data-pos="tr"] { top: 18px; right: 18px; transform-origin: 100% 0; }
    .toast-wrap[data-pos="tl"] { top: 18px; left: 18px; transform-origin: 0 0; }
    .toast-wrap[data-pos="br"] { bottom: 18px; right: 18px; transform-origin: 100% 100%; }
    .toast-wrap[data-pos="bl"] { bottom: 18px; left: 18px; transform-origin: 0 100%; }

    .toast {
      display: flex; align-items: baseline;
      padding: 8px 13px 9px; border-radius: 11px;
      background: rgba(17, 24, 39, .9); color: #fff;
      font: 700 16px/1 system-ui, -apple-system, "Segoe UI", "PingFang SC",
            "Microsoft YaHei", Roboto, sans-serif;
      letter-spacing: -.02em;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .26);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      opacity: 0; transform: translateY(-6px);
      transition: opacity 160ms cubic-bezier(.23, 1, .32, 1),
                  transform 200ms cubic-bezier(.23, 1, .32, 1);
      pointer-events: none; user-select: none;
    }
    .toast.show { opacity: 1; transform: none; }

    .panel-wrap {
      position: fixed;
      transform: scale(var(--ps, 1));
      transform-origin: 0 0;
    }

    .panel {
      display: none;
      width: 158px; padding: 7px 8px 6px;
      border-radius: 12px;
      background: rgba(17, 24, 39, .9);
      box-shadow: 0 8px 28px rgba(0, 0, 0, .3);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      font: 600 12px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC",
            "Microsoft YaHei", Roboto, sans-serif;
      letter-spacing: .002em;
      color: #fff; user-select: none;
      opacity: 0; transform: translateY(6px);
      transition: opacity 150ms cubic-bezier(.23, 1, .32, 1),
                  transform 200ms cubic-bezier(.23, 1, .32, 1);
      touch-action: none;
    }
    .panel.show { display: block; opacity: 1; transform: none; }

    .row { display: flex; align-items: center; gap: 6px; cursor: grab; }
    .row:active { cursor: grabbing; }
    .row button { cursor: pointer; }

    .val {
      flex: 1 1 auto; text-align: center;
      font-size: 18px; font-weight: 700;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      font-feature-settings: "tnum" 1;
      letter-spacing: -.03em;
    }
    .val .u { font-size: 11px; font-weight: 600; color: #9ca3af; margin-left: 1px; letter-spacing: .02em; }

    .mini {
      width: 22px; height: 22px; flex: 0 0 auto;
      display: grid; place-items: center;
      border: 0; border-radius: 6px;
      background: rgba(255, 255, 255, .12);
      color: #e5e7eb; font-size: 14px; font-weight: 700;
      line-height: 1; padding: 0;
      transition: background-color 130ms cubic-bezier(.23, 1, .32, 1),
                  transform 110ms cubic-bezier(.23, 1, .32, 1);
    }
    .mini:hover { background: rgba(255, 255, 255, .24); }
    .mini:active { transform: scale(.9); background: rgba(255, 255, 255, .3); }

    .idx {
      font-size: 9.5px; font-weight: 600; color: #9ca3af;
      letter-spacing: .03em;
      font-variant-numeric: tabular-nums;
      padding: 0 2px; min-width: 16px; text-align: center;
    }

    .close {
      width: 18px; height: 18px; flex: 0 0 auto;
      display: grid; place-items: center;
      border: 0; border-radius: 5px; padding: 0;
      background: transparent; color: #6b7280;
      font-size: 12px; line-height: 1;
      transition: color 130ms cubic-bezier(.23, 1, .32, 1),
                  background-color 130ms cubic-bezier(.23, 1, .32, 1),
                  transform 110ms cubic-bezier(.23, 1, .32, 1);
    }
    .close:hover { background: rgba(255, 255, 255, .12); color: #e5e7eb; }
    .close:active { transform: scale(.86); }

    .bar {
      position: relative; height: 12px; margin-top: 5px;
      display: flex; align-items: center; cursor: pointer;
    }
    .bar .track {
      position: absolute; left: 0; right: 0; height: 3px;
      border-radius: 2px; background: rgba(255, 255, 255, .16);
    }
    .bar .fill {
      position: absolute; left: 0; height: 3px;
      border-radius: 2px; background: #4ade80;
      pointer-events: none;
    }
    .bar .knob {
      position: absolute; width: 9px; height: 9px;
      border-radius: 50%; background: #fff;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .4);
      transform: translateX(-50%);
      pointer-events: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .toast, .panel, .mini, .close {
        transition-duration: 1ms !important;
      }
      .toast:not(.show) { transform: none !important; }
      .panel:not(.show) { transform: none !important; }
      .mini:active, .close:active { transform: none !important; }
    }
  `;

  function ensureUI() {
    if (uiHost && uiHost.isConnected) return true;
    const root = document.documentElement;
    if (!root) return false;

    uiHost = document.createElement('div');
    uiHost.id = '__vsp_ui__';
    uiHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    uiRoot = uiHost.attachShadow({ mode: 'open' });
    uiRoot.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="toast-wrap" data-pos="tr"><div class="toast"></div></div>' +
      '<div class="panel-wrap">' +
        '<div class="panel">' +
          '<div class="row">' +
            '<button class="mini" data-act="slower" title="减速">−</button>' +
            '<span class="val"><span class="n">1</span><span class="u">×</span></span>' +
            '<button class="mini" data-act="faster" title="加速">+</button>' +
            '<span class="idx"></span>' +
            '<button class="close" title="隐藏面板">✕</button>' +
          '</div>' +
          '<div class="bar"><div class="track"></div><div class="fill"></div><div class="knob"></div></div>' +
        '</div>' +
      '</div>';

    root.appendChild(uiHost);

    toastWrap = uiRoot.querySelector('.toast-wrap');
    toastEl = uiRoot.querySelector('.toast');
    panelWrap = uiRoot.querySelector('.panel-wrap');
    panelEl = uiRoot.querySelector('.panel');

    applyOverlayStyle();
    wirePanel();
    return true;
  }

  /** 角标位置 / 角标与面板的缩放，全部走 CSS 变量与 data 属性 */
  function applyOverlayStyle() {
    if (!toastWrap) return;
    toastWrap.dataset.pos = opts.overlayPos || 'tr';
    toastWrap.style.setProperty('--ts', String(opts.overlayScale || 1));
    if (panelWrap) {
      panelScale = Number(opts.panelScale) || 1;
      panelWrap.style.setProperty('--ps', String(panelScale));
    }
  }

  /* ---------------------------- 角标 ------------------------------- */

  function showToast(text) {
    if (!opts.overlay || !ROOT_FRAME) return;
    if (!ensureUI()) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove('show');
    }, 1100);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.remove('show');
  }

  /* --------------------------- 浮动面板 ---------------------------- */

  const ratio = Math.log(MAX / MIN);
  const posOfRate = (r) => (Math.log(Math.min(MAX, Math.max(MIN, r)) / MIN) / ratio) * 100;
  const rateOfPos = (p) => clampRate(MIN * Math.exp((p / 100) * ratio));

  function loadPanelPos() {
    try {
      chrome.storage.local.get({ panelPos: null }, (got) => {
        void chrome.runtime.lastError;
        const p = got && got.panelPos;
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          panelPos = p;
          applyPanelPos();
        }
      });
    } catch (e) { /* ignore */ }
  }

  function defaultPanelPos() {
    const s = panelScale || 1;
    return {
      x: Math.max(8, window.innerWidth - 158 * s - 20),
      y: Math.max(8, window.innerHeight - 56 * s - 44)
    };
  }

  function applyPanelPos() {
    if (!panelWrap) return;
    const p = panelPos || defaultPanelPos();
    const s = panelScale || 1;
    // offsetWidth/Height 是布局尺寸，乘缩放才是屏幕上的实际占位
    const w = (panelEl ? panelEl.offsetWidth : 158) * s;
    const h = (panelEl ? panelEl.offsetHeight : 52) * s;
    const maxX = Math.max(4, window.innerWidth - w - 4);
    const maxY = Math.max(4, window.innerHeight - h - 4);
    const x = Math.min(Math.max(4, p.x), maxX);
    const y = Math.min(Math.max(4, p.y), maxY);
    panelWrap.style.left = x + 'px';
    panelWrap.style.top = y + 'px';
  }

  function showPanel() {
    if (!ROOT_FRAME || !opts.panel || panelHidden) return;
    if (!mediaList().length) return;
    if (!ensureUI()) return;
    if (!panelPos) panelPos = defaultPanelPos();
    applyPanelPos();
    updatePanel();
    panelEl.classList.add('show');
    schedulePanelHide();
  }

  function hidePanel() {
    clearTimeout(panelHideTimer);
    if (panelEl) panelEl.classList.remove('show');
  }

  function schedulePanelHide() {
    clearTimeout(panelHideTimer);
    panelHideTimer = setTimeout(() => {
      const list = targetList();
      const playing = list.some((m) => !m.paused && !m.ended);
      if (!playing && !panelDragging) hidePanel();
    }, 4000);
  }

  function updatePanel() {
    if (!panelEl) return;
    const n = panelEl.querySelector('.n');
    if (n) n.textContent = fmt(target);

    const p = posOfRate(target);
    const fill = panelEl.querySelector('.fill');
    const knob = panelEl.querySelector('.knob');
    if (fill) fill.style.width = p + '%';
    if (knob) knob.style.left = p + '%';

    const idx = panelEl.querySelector('.idx');
    const count = mediaList().length;
    if (idx) {
      if (focusIndex >= 0 && count > 1) idx.textContent = (focusIndex + 1) + '/' + count;
      else if (count > 1) idx.textContent = '•' + count;
      else idx.textContent = '';
    }
  }

  function wirePanel() {
    if (!panelEl) return;

    panelEl.querySelector('[data-act="slower"]').addEventListener('click', (e) => {
      e.stopPropagation();
      runAction('slower');
    });
    panelEl.querySelector('[data-act="faster"]').addEventListener('click', (e) => {
      e.stopPropagation();
      runAction('faster');
    });
    panelEl.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      panelHidden = true;
      hidePanel();
    });

    // 进度条点击 / 拖动直接设速度
    const bar = panelEl.querySelector('.bar');
    let barDrag = false;

    const setFromBar = (clientX) => {
      const rect = bar.getBoundingClientRect();
      if (!rect.width) return;
      const p = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
      const r = rateOfPos(p);
      if (Math.abs(r - target) < 0.005) return;
      target = r;
      forceApply();
      updatePanel();
      persistRate(r);
    };

    bar.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      barDrag = true;
      bar.setPointerCapture(e.pointerId);
      setFromBar(e.clientX);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!barDrag) return;
      e.stopPropagation();
      setFromBar(e.clientX);
    });
    bar.addEventListener('pointerup', (e) => {
      if (!barDrag) return;
      barDrag = false;
      try { bar.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      showToast(fmt(target) + '×');
    });

    // 拖动面板本体
    const row = panelEl.querySelector('.row');
    let dragOffset = null;

    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      panelDragging = true;
      const rect = panelEl.getBoundingClientRect();
      dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      row.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    row.addEventListener('pointermove', (e) => {
      if (!dragOffset) return;
      panelPos = { x: e.clientX - dragOffset.dx, y: e.clientY - dragOffset.dy };
      applyPanelPos();
    });

    const endDrag = (e) => {
      if (!dragOffset) return;
      dragOffset = null;
      panelDragging = false;
      try { row.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      try {
        chrome.storage.local.set({ panelPos: panelPos });
      } catch (err) { /* ignore */ }
      schedulePanelHide();
    };

    row.addEventListener('pointerup', endDrag);
    row.addEventListener('pointercancel', endDrag);

    panelEl.addEventListener('pointerenter', () => clearTimeout(panelHideTimer));
    panelEl.addEventListener('pointerleave', () => schedulePanelHide());

    window.addEventListener('resize', () => {
      if (panelEl && panelEl.classList.contains('show')) applyPanelPos();
    });
  }

  /* ---------------------------- 事件绑定 -------------------------- */

  // 组合键是否命中（用 e.code 匹配，不受输入法与大小写影响）
  function matchBinding(e, b) {
    if (!b || !b.code) return false;
    return (
      e.code === b.code &&
      !!e.ctrlKey === !!b.ctrl &&
      !!e.altKey === !!b.alt &&
      !!e.shiftKey === !!b.shift &&
      !!e.metaKey === !!b.meta
    );
  }

  const ACTION_ORDER = [
    'faster', 'slower', 'finer', 'coarser', 'reset', 'toggleRate', 'presetNext',
    'back5', 'fwd5', 'toggleOverlay', 'toggleLock', 'prevVideo', 'nextVideo'
  ];

  window.addEventListener('play', (e) => {
    const m = e.target;
    if (!isMedia(m)) return;
    reportStats();
    if (blockedHere) return;
    const cur = m.playbackRate || 1;
    if (opts.lock) applyTo(m, target);
    else if (opts.autoApply && Math.abs(cur - 1) < 0.0005 && Math.abs(target - 1) > 0.0005) {
      applyTo(m, target);
    }
    showPanel();
  }, true);

  window.addEventListener('pause', (e) => {
    if (!isMedia(e.target)) return;
    schedulePanelHide();
    reportStats();
  }, true);

  // 强力锁定：网站偷偷改回去就立刻改回来
  document.addEventListener('ratechange', (e) => {
    const m = e.target;
    if (!isMedia(m) || setting.has(m)) return;
    if (!opts.lock) return;
    if (Math.abs((m.playbackRate || 1) - target) < 0.0005) return;
    setTimeout(() => applyTo(m, target), 0);
  }, true);

  // 页面内快捷键（用户可自定义）
  /**
   * 光标是否落在可输入的位置。
   *
   * 用 composedPath 穿透 Shadow DOM —— NAS 面板、后台管理系统这类应用的输入框
   * 常挂在 shadow root 里，事件冒到 window 时 target 已被重定向成宿主元素，
   * 只判断 e.target 会漏掉，结果就是「在密码框里打不出字」。
   */
  function isTypingTarget(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];

    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(node.tagName || '')) return true;
      if (node.isContentEditable) return true;
      const role = node.getAttribute && node.getAttribute('role');
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    }

    // 富文本框有时只把 contenteditable 标在祖先节点上
    const sel = document.getSelection && document.getSelection();
    let n = sel && sel.anchorNode;
    if (n && n.nodeType !== 1) n = n.parentElement;
    for (let i = 0; n && i < 6; i++) {
      if (n.isContentEditable) return true;
      n = n.parentElement;
    }
    return false;
  }

  window.addEventListener('keydown', (e) => {
    if (!opts.keysEnabled) return;
    if (opts.enabled === false) return;

    // 站点被排除时，连按键都不能碰。否则扩展「不干活但占着键」，
    // 用户会以为键盘坏了 —— 这正是 NAS 面板里打不出字的原因。
    if (blockedHere) return;

    if (isTypingTarget(e)) return;

    // 页面上没有可控制的媒体就不占用按键。
    // 后台管理、NAS、文档站这类页面本就不该被快捷键干扰。
    if (!document.querySelectorAll('video,audio').length) return;

    const map = opts.keymap || {};
    let action = null;
    for (const name of ACTION_ORDER) {
      if (matchBinding(e, map[name])) {
        action = name;
        break;
      }
    }
    if (!action) return;

    e.preventDefault();
    e.stopPropagation();
    runAction(action);
  }, true);

  /* ------------------------- DOM 变化监听 ------------------------- */

  let moTimer = null;

  function startObserver() {
    if (!document.documentElement) {
      setTimeout(startObserver, 50);
      return;
    }
    const mo = new MutationObserver(() => {
      if (moTimer) return;
      moTimer = setTimeout(() => {
        moTimer = null;
        softSync();
        if (panelEl && panelEl.classList.contains('show')) updatePanel();
      }, 400);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  startObserver();

  // 兜底轮询：很多播放器切集时会把速度重置，光靠事件抓不稳
  setInterval(() => {
    softSync();
    if (panelEl && panelEl.classList.contains('show')) updatePanel();
  }, 800);

  /* --------------------------- 统计上报 --------------------------- */

  let lastSig = '';

  function reportStats() {
    if (!port) return;
    const list = mediaList();
    const playing = list.some((m) => !m.paused && !m.ended);
    const active = list.find((m) => !m.paused && !m.ended) || list[0];
    const duration = active && Number.isFinite(active.duration) ? Math.round(active.duration) : 0;
    const currentTime = active ? Math.round(active.currentTime || 0) : 0;

    // 秒数按 5 秒粒度参与去重，避免每秒都往后台发消息
    const sig = list.length + '|' + (playing ? 1 : 0) + '|' + duration + '|' + Math.floor(currentTime / 5);
    if (sig === lastSig) return;
    lastSig = sig;

    try {
      port.postMessage({ type: 'stats', videos: list.length, playing, duration, currentTime });
    } catch (e) { /* gone */ }
  }

  setInterval(reportStats, 1200);

  /* --------------------------- 端口连接 --------------------------- */

  function onMessage(msg) {
    if (!msg || msg.type !== 'state') return;

    const prev = target;
    const prevPanel = opts.panel;
    target = clampRate(msg.rate);
    if (msg.opts) opts = msg.opts;
    if (Array.isArray(msg.presets) && msg.presets.length) presets = msg.presets;

    // 位置 / 缩放在每次状态推送后同步，改动即时生效
    applyOverlayStyle();

    // 站点被排除：把速度还回 1x，然后彻底停手，不再干扰这个页面
    if (msg.blocked) {
      if (!blockedHere) {
        blockedHere = true;
        target = 1;
        forceApply();
        hidePanel();
        hideToast();
      }
      initialized = true;
      return;
    }
    blockedHere = false;

    // 用户在 popup 里重新打开面板 → 解除本页的手动关闭
    if (!prevPanel && opts.panel) panelHidden = false;

    const changed = !initialized || Math.abs(target - prev) > 0.0005;

    if (changed) {
      forceApply();
      if (initialized) showToast(fmt(target) + '×');
    } else {
      softSync();
    }
    initialized = true;

    // 总开关关闭：不做任何 UI 打扰，速度已随 rate=1 恢复
    if (opts.enabled === false) {
      hidePanel();
      hideToast();
      return;
    }

    if (opts.panel && !panelHidden && mediaList().length) showPanel();
    else hidePanel();
    updatePanel();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 800);
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'vsp' });
    } catch (e) {
      port = null;
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener(onMessage);

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      scheduleReconnect();
    });

    try {
      port.postMessage({ type: 'hello', url: location.href });
    } catch (e) { /* gone */ }

    lastSig = '';
    reportStats();
  }

  connect();
  loadPanelPos();

  // service worker 闲置会被回收，页面有视频时保持轻微心跳
  setInterval(() => {
    if (!port) return;
    if (!mediaList().length) return;
    try {
      port.postMessage({ type: 'ping' });
    } catch (e) { /* gone */ }
  }, 25000);
})();
