/* 看图器手势回归测试：把 app.js 里看图器那段（从 let progressEl 到 lightbox.init() 之前）
   原样放进 vm，配上最小 DOM stub，真实驱动上滑圆环 / 下滑关闭 / 速度判定 / 横移锁定。
   运行：node tests/gesture_test.js（仓库根目录）。Docker 镜像只 COPY app/，这里不进镜像。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'app.js'), 'utf8');
const start = src.indexOf('let progressEl = null');
const end = src.indexOf('lightbox.init();');
assert(start > 0 && end > start, 'slice markers not found');
const slice = src.slice(start, end);

// ---- 最小 DOM stub ----
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    style: {},
    hidden: false,
    offsetWidth: 0,
    parentNode: null,
    _rect: { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 },
    _classes: new Set(),
    _anims: [],
    _handlers: {},
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
    },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      }
    },
    addEventListener(evt, fn) { el._handlers[evt] = fn; },
    removeEventListener(evt) { delete el._handlers[evt]; },
    querySelector(sel) {
      const name = sel.replace(/^\./, '');
      return el.children.find(c => c._classes.has(name)) || null;
    },
    getBoundingClientRect() { return el._rect; },
    animate(kfs, opts) {
      const a = { keyframes: kfs, opts, onfinish: null, cancelled: false, cancel() { a.cancelled = true; } };
      el._anims.push(a);
      return a;
    },
    getAnimations() { return el._anims.filter(a => !a.cancelled); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML || ''; },
    set(v) {
      el._innerHTML = v;
      const re = /class="([^"]+)"/g;
      let m;
      while ((m = re.exec(v))) {
        m[1].split(/\s+/).forEach(cls => {
          const c = makeEl('div');
          c._classes.add(cls);
          el.appendChild(c);
        });
      }
    },
  });
  Object.defineProperty(el, 'className', {
    get() { return [...el._classes].join(' '); },
    set(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  return el;
}

const hostEl = makeEl('div');
hostEl._rect = { left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 };
const wrapEl = makeEl('div');

const sandbox = {
  console, Math, JSON,
  setTimeout, clearTimeout,
  document: { createElement: tag => makeEl(tag) },
  lightbox: {
    pswp: {
      element: hostEl,
      scrollWrap: wrapEl,
      currIndex: 0,
      currSlide: null,
      closeCalls: 0,
      close() { this.closeCalls++; },
      _handlers: {},
      on(evt, fn) { this._handlers[evt] = fn; },
    },
    _handlers: {},
    on(evt, fn) { this._handlers[evt] = fn; },
  },
};
vm.createContext(sandbox);
vm.runInContext(slice, sandbox);

// ---- 第二段脚本：补上 slice 之外的依赖 + 测试 ----
const driver = `
var root = 'photos';
viewerPhotos = [{ path: 'a.jpg', name: 'a.jpg', saved: false }];
var savePhotoCalls = [];
function markViewedRange() {}
// close 处理里调 renderGrid（1.0.5：修未看过筛选下标错位）：桩只计数
var renderGridCalls = 0;
function renderGrid() { renderGridCalls++; }
var suppressResumeOnce = false;
var lastViewed = null;
function savePhoto(p) {
  savePhotoCalls.push(p);
  if (root === 'saved') return;  // 真实分支：收藏夹不播圆环，只 toast（桩里不发 toast）
  if (!p || p.saved) return;
  p.saved = true;
  saveDotPending = true;
  syncViewerOverlay();
  confirmSaveRing();
}
viewerOpen = true;
function firePointerMove(x, y) {
  const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
              originalEvent: { clientX: x, clientY: y } };
  const h = lightbox.pswp._handlers['pointerMove'];
  if (h) h(e);
  return e.defaultPrevented;
}
globalThis.T = {};
Object.defineProperties(globalThis.T, {
  saveRingEl: { get() { return saveRingEl; } },
  saveRingFill: { get() { return saveRingFill; } },
  progressEl: { get() { return progressEl; } },
  progressDot: { get() { return progressDot; } },
  saveDotPending: { get() { return saveDotPending; } },
  viewerPhotos: { get() { return viewerPhotos; } },
  hostEl: { get() { return lightbox.pswp.element; } },
  wrapEl: { get() { return lightbox.pswp.scrollWrap; } },
});
lightbox._handlers['afterInit']();
// 摆好各元素的位置：圆环中心 (195,422)，黄点中心 (304,804)，进度条右端 265
saveRingEl._rect = { left: 157, top: 384, width: 76, height: 76, right: 233, bottom: 460 };
progressDot._rect = { left: 300, top: 800, width: 8, height: 8, right: 308, bottom: 808 };
progressEl.querySelector('.vp-track')._rect = { left: 125, top: 820, width: 140, height: 3, right: 265, bottom: 823 };

function touch(type, x, y, t, touches) {
  const e = { timeStamp: t, touches: touches, changedTouches: [{ clientX: x, clientY: y }] };
  if (type === 'start') onViewerTouchStart(e);
  else if (type === 'move') onViewerTouchMove(e);
  else onViewerTouchEnd(e);
}
function oneTouch(x, y, t) { return [{ clientX: x, clientY: y }]; }
function noTouch() { return []; }
`;

const results = [];
function check(name, fn) {
  try { fn(); results.push('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ' :: ' + e.message); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  vm.runInContext(driver, sandbox);
  const S = sandbox;
  const RING_C = 2 * Math.PI * 44;

  // T1：上滑 -60px，圆环填一半
  vm.runInContext(`touch('start', 195, 400, 1000, oneTouch(195, 400)); touch('move', 195, 340, 1050, oneTouch(195, 340));`, sandbox);
  check('T1 ring preview at p=0.5', () => {
    assert.strictEqual(S.T.saveRingEl.hidden, false);
    assert.ok(Math.abs(parseFloat(S.T.saveRingEl.style.opacity) - 0.5) < 0.01, 'opacity ' + S.T.saveRingEl.style.opacity);
    assert.ok(S.T.saveRingEl.style.transform.includes('scale(0.835)'), S.T.saveRingEl.style.transform);
    assert.ok(Math.abs(parseFloat(S.T.saveRingFill.style.strokeDashoffset) - RING_C * 0.5) < 0.01,
      'dashoffset ' + S.T.saveRingFill.style.strokeDashoffset);
    assert.ok(Math.abs(parseFloat(S.T.saveRingFill.style.strokeWidth) - 6.25) < 0.01);
  });

  // T2：继续上滑到 -100 松手 -> 保存，光点飞向黄点，落点圆点弹出
  vm.runInContext(`touch('move', 195, 300, 1100, oneTouch(195, 300)); touch('end', 195, 300, 1150, noTouch());`, sandbox);
  check('T2 save triggered', () => {
    assert.strictEqual(S.savePhotoCalls.length, 1);
    assert.strictEqual(S.T.viewerPhotos[0].saved, true);
    assert.strictEqual(S.T.saveDotPending, true);
    assert.strictEqual(S.T.progressDot.hidden, false);  // 先放出来但透明着，等落点
    assert.strictEqual(S.T.progressDot.style.opacity, '0');
    const flyer = S.T.hostEl.children.find(c => c.className === 'save-flyer');
    assert.ok(flyer, 'flyer created');
    assert.ok(flyer._anims.length === 1, 'fly animation started');
    // 手动触发飞行结束
    flyer._anims[0].onfinish();
    assert.strictEqual(S.T.saveDotPending, false);
    assert.strictEqual(S.T.progressDot.style.opacity, '');
    assert.strictEqual(S.T.progressDot.hidden, false);
    assert.ok(S.T.progressDot.classList.contains('pop'), 'dot pops');
    assert.ok(!S.T.hostEl.children.find(c => c.className === 'save-flyer'), 'flyer removed');
    assert.ok(S.T.hostEl.children.find(c => c.className === 'save-halo'), 'halo created');
  });
  await sleep(350);  // 等圆环 240ms 收尾定时器
  check('T2b ring hidden after collapse', () => {
    assert.strictEqual(S.T.saveRingEl.hidden, true);
  });

  // T8（先做，趁热）：第二张再拖一次，圆环还能正常长大（冻环回归）
  vm.runInContext(`
    viewerPhotos[0] = { path: 'b.jpg', name: 'b.jpg', saved: false };
    touch('start', 195, 400, 2000, oneTouch(195, 400));
    touch('move', 195, 340, 2050, oneTouch(195, 340));
  `, sandbox);
  check('T8 second drag ring grows again (no frozen ring)', () => {
    assert.strictEqual(S.T.saveRingEl.hidden, false);
    assert.ok(Math.abs(parseFloat(S.T.saveRingEl.style.opacity) - 0.5) < 0.01);
    assert.ok(S.T.saveRingEl.style.transform.includes('scale(0.835)'));
  });
  vm.runInContext(`touch('end', 195, 340, 2100, noTouch());`, sandbox);
  await sleep(250);

  // T3：下滑 120px，图片下移+缩小+淡出；松手过线，延续动画后关闭
  vm.runInContext(`
    viewerPhotos[0] = { path: 'c.jpg', name: 'c.jpg', saved: false };
    touch('start', 195, 400, 3000, oneTouch(195, 400));
    touch('move', 195, 520, 3050, oneTouch(195, 520));
  `, sandbox);
  check('T3 down-drag follows finger with scale+fade', () => {
    assert.ok(S.T.wrapEl.style.transform.includes('translateY(72px)'), S.T.wrapEl.style.transform);
    assert.ok(S.T.wrapEl.style.transform.includes('scale(0.8875)'), S.T.wrapEl.style.transform);
    assert.ok(Math.abs(parseFloat(S.T.wrapEl.style.opacity) - 0.88) < 0.01, S.T.wrapEl.style.opacity);
    assert.ok(Math.abs(parseFloat(S.T.progressEl.style.opacity) - 0.88) < 0.01);
  });
  vm.runInContext(`touch('end', 195, 520, 3060, noTouch());`, sandbox);
  check('T3b close continuation starts', () => {
    assert.ok(S.T.wrapEl.style.transform.includes('scale(0.8)'), S.T.wrapEl.style.transform);
    assert.strictEqual(S.T.wrapEl.style.opacity, '0');
  });
  await sleep(300);
  check('T3c viewer closed', () => {
    assert.strictEqual(S.lightbox.pswp.closeCalls, 1);
  });

  // T4：下滑 40px 慢慢放，没过线，弹簧弹回
  vm.runInContext(`
    touch('start', 195, 400, 5000, oneTouch(195, 400));
    touch('move', 195, 420, 5100, oneTouch(195, 420));
    touch('move', 195, 440, 5200, oneTouch(195, 440));
    touch('end', 195, 440, 5250, noTouch());
  `, sandbox);
  check('T4 slow short drag springs back, no close', () => {
    assert.strictEqual(S.lightbox.pswp.closeCalls, 1);
    assert.strictEqual(S.T.wrapEl.style.transform, '');
    assert.ok(S.T.wrapEl.style.transition.includes('cubic-bezier(.2,.9,.3,1.15)'), S.T.wrapEl.style.transition);
  });

  // T5：下滑只拉 40px 但甩得快（vy=2.0），也关
  vm.runInContext(`
    touch('start', 195, 400, 6000, oneTouch(195, 400));
    touch('move', 195, 430, 6010, oneTouch(195, 430));
    touch('move', 195, 440, 6020, oneTouch(195, 440));
    touch('end', 195, 440, 6030, noTouch());
  `, sandbox);
  await sleep(300);
  check('T5 fast flick closes despite short distance', () => {
    assert.strictEqual(S.lightbox.pswp.closeCalls, 2);
  });

  // T6：上滑 -50px 没过线松手，圆环淡出藏起
  vm.runInContext(`
    touch('start', 195, 400, 7000, oneTouch(195, 400));
    touch('move', 195, 350, 7050, oneTouch(195, 350));
    touch('end', 195, 350, 7100, noTouch());
  `, sandbox);
  await sleep(250);
  check('T6 up-cancel hides ring', () => {
    assert.strictEqual(S.T.saveRingEl.hidden, true);
  });

  // T10：收藏夹模式上滑，大圈全程不出现（拖动不显现，松手也不飞）
  vm.runInContext(`
    root = 'saved';
    viewerPhotos[0] = { path: 'e.jpg', name: 'e.jpg', saved: true };
    progressDot.hidden = true;
    touch('start', 195, 400, 8000, oneTouch(195, 400));
    touch('move', 195, 340, 8050, oneTouch(195, 340));
  `, sandbox);
  check('T10a favorites drag shows no ring', () => {
    assert.strictEqual(S.T.saveRingEl.hidden, true);
  });
  vm.runInContext(`
    touch('move', 195, 300, 8100, oneTouch(195, 300));
    touch('end', 195, 300, 8150, noTouch());
  `, sandbox);
  check('T10b favorites release: no flyer, no ring', () => {
    assert.strictEqual(S.savePhotoCalls.length, 2);  // 只记了调用，不播动画
    assert.ok(!S.T.hostEl.children.find(c => c.className === 'save-flyer'));
    assert.strictEqual(S.T.saveRingEl.hidden, true);
    assert.strictEqual(S.T.progressDot.hidden, true);
  });

  // T9：change 处理：存完立刻滑走，pending 取消
  vm.runInContext(`
    root = 'photos';
    viewerPhotos[0] = { path: 'd.jpg', name: 'd.jpg', saved: false };
    savePhoto(viewerPhotos[0]);
    lightbox._handlers['change']();
  `, sandbox);
  check('T9 change cancels pending flight', () => {
    assert.strictEqual(S.T.saveDotPending, false);
    assert.strictEqual(S.T.saveRingEl.hidden, true);
  });

  // T11：上滑锁轴后，PhotoSwipe 的横移被拦掉；转成横向立刻放开
  vm.runInContext(`
    root = 'photos';
    viewerPhotos[0] = { path: 'f.jpg', name: 'f.jpg', saved: false };
    touch('start', 195, 400, 9000, oneTouch(195, 400));
    touch('move', 195, 340, 9050, oneTouch(195, 340));
  `, sandbox);
  check('T11a up-drag locks horizontal pan', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(195, 340)', sandbox), true);
  });
  vm.runInContext(`touch('move', 300, 340, 9100, oneTouch(300, 340));`, sandbox);
  check('T11b veering horizontal releases the lock', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(300, 340)', sandbox), false);
  });
  vm.runInContext(`touch('end', 300, 340, 9150, noTouch());`, sandbox);

  // T12：横滑从头到尾不锁
  vm.runInContext(`
    touch('start', 195, 400, 10000, oneTouch(195, 400));
    touch('move', 255, 400, 10050, oneTouch(255, 400));
  `, sandbox);
  check('T12 horizontal swipe never locked', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(255, 400)', sandbox), false);
  });
  vm.runInContext(`touch('end', 255, 400, 10100, noTouch());`, sandbox);

  // T13：下滑也锁
  vm.runInContext(`
    touch('start', 195, 400, 11000, oneTouch(195, 400));
    touch('move', 195, 460, 11050, oneTouch(195, 460));
  `, sandbox);
  check('T13 down-drag locks horizontal pan', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(195, 460)', sandbox), true);
  });
  vm.runInContext(`touch('end', 195, 460, 11100, noTouch());`, sandbox);

  // T14：松手后锁放开
  check('T14 lock released after touch end', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(195, 460)', sandbox), false);
  });

  // T15：放大看细节时竖直拖动是平移图片，不锁
  vm.runInContext(`
    lightbox.pswp.currSlide = { currZoomLevel: 2, zoomLevels: { fit: 1 } };
    touch('start', 195, 400, 12000, oneTouch(195, 400));
    touch('move', 195, 340, 12050, oneTouch(195, 340));
  `, sandbox);
  check('T15 zoomed pan not locked', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(195, 340)', sandbox), false);
  });
  vm.runInContext(`
    touch('end', 195, 340, 12100, noTouch());
    lightbox.pswp.currSlide = null;
  `, sandbox);

  // T16：上滑 -15px，自己的 16px 锁轴还没定，横移必须已经锁了（v1.24 的漏网点）
  vm.runInContext(`
    touch('start', 195, 400, 13000, oneTouch(195, 400));
    touch('move', 195, 385, 13050, oneTouch(195, 385));
  `, sandbox);
  check('T16 lock engages before our 16px axis lock', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(195, 385)', sandbox), true);
  });
  vm.runInContext(`touch('end', 195, 385, 13100, noTouch());`, sandbox);

  // T17：斜着上滑，竖直占优，锁
  vm.runInContext(`
    touch('start', 195, 400, 14000, oneTouch(195, 400));
    touch('move', 200, 380, 14050, oneTouch(200, 380));
  `, sandbox);
  check('T17 diagonal-but-vertical locks', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(200, 380)', sandbox), true);
  });
  vm.runInContext(`touch('end', 200, 380, 14100, noTouch());`, sandbox);

  // T18：斜着上滑，横向占优，不锁
  vm.runInContext(`
    touch('start', 195, 400, 15000, oneTouch(195, 400));
    touch('move', 220, 385, 15050, oneTouch(220, 385));
  `, sandbox);
  check('T18 diagonal-but-horizontal does not lock', () => {
    assert.strictEqual(vm.runInContext('firePointerMove(220, 385)', sandbox), false);
  });
  vm.runInContext(`touch('end', 220, 385, 15100, noTouch());`, sandbox);

  // T19：看图器关闭时重绘网格（1.0.5）：筛选是“未看过”时，刚看过的几张
  // 已经不在筛选里了，不重绘网格下标就错位；lastViewed 要原样留着，
  // 下次回这个目录还能定位到上次看到的照片。
  const beforeClose = S.renderGridCalls;
  vm.runInContext(`lastViewed = 'a.jpg'; lightbox._handlers['close']();`, sandbox);
  check('T19 close re-renders grid and keeps lastViewed', () => {
    assert.strictEqual(S.renderGridCalls, beforeClose + 1);
    assert.strictEqual(S.lastViewed, 'a.jpg');
  });

  console.log(results.join('\n'));
  if (results.some(r => r.startsWith('FAIL'))) process.exit(1);
  console.log('ALL GESTURE TESTS PASSED');
})();
