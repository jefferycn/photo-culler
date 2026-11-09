import PhotoSwipeLightbox from './vendor/photoswipe-lightbox.esm.js';

const grid = document.getElementById('grid');
const foldersEl = document.getElementById('folders');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const crumbsEl = document.getElementById('crumbs');
const toastEl = document.getElementById('toast');
const ptrEl = document.getElementById('ptr');
const ptrText = document.getElementById('ptr-text');
const filtersEl = document.querySelector('.filters');
const pageContent = document.getElementById('page-content');
const backHint = document.getElementById('back-hint');

let allPhotos = [];      // 当前目录下的照片
let folders = [];
let folder = '';         // 当前目录相对路径，'' 为根目录
let filter = 'all';
let lastViewed = null;

// 两个视图：照片库（源目录）和收藏夹（目标目录 DEST_DIR）。
// 每个视图各记各的当前目录和筛选，切换不丢位置；上次选的视图下次打开恢复。
let root = localStorage.getItem('culler-root') === 'saved' ? 'saved' : 'photos';
const viewState = {
  photos: { folder: '', filter: 'all' },
  saved: { folder: '', filter: 'all' },
};
folder = viewState[root].folder;
filter = viewState[root].filter;
const cacheKey = f => `${root}:${f}`;
const scrollKey = f => `${root}:${f}`;

const api = (p, opts) => fetch(p, opts).then(r => {
  if (!r.ok) throw new Error(r.status);
  return r.json();
});
const enc = encodeURIComponent;
const post = (p, body) => api(p, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

// ---------- 添加到主屏幕提示（Safari 里开网页不能全屏，主屏幕打开才可以） ----------
const hintBar = document.getElementById('homescreen-hint');
const isStandalone = window.navigator.standalone ||
  window.matchMedia('(display-mode: standalone)').matches;
if (!isStandalone && !localStorage.getItem('hide-homescreen-hint')) {
  hintBar.hidden = false;
}
document.getElementById('homescreen-dismiss').addEventListener('click', () => {
  hintBar.hidden = true;
  localStorage.setItem('hide-homescreen-hint', '1');
});

// ---------- 列表 ----------
function visiblePhotos() {
  if (filter === 'unviewed') return allPhotos.filter(p => !p.viewed);
  if (filter === 'viewed') return allPhotos.filter(p => p.viewed);
  if (filter === 'saved') return allPhotos.filter(p => p.saved);
  return allPhotos;
}

function refreshCounts() {
  const vis = visiblePhotos();
  // 收藏夹里全是已保存的，不显示“已保存 X”，只显示张数和已看
  countEl.textContent = root === 'saved'
    ? `${vis.length} 张 · 已看 ${allPhotos.filter(p => p.viewed).length}`
    : `${vis.length} 张 · 已保存 ${allPhotos.filter(p => p.saved).length}` +
      ` · 已看 ${allPhotos.filter(p => p.viewed).length}`;
}

function renderCrumbs() {
  const parts = folder ? folder.split('/') : [];
  crumbsEl.innerHTML = '';
  const mk = (label, target, current) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (current) b.classList.add('current');
    else b.addEventListener('click', () => navigateTo(target));
    crumbsEl.appendChild(b);
  };
  mk(root === 'saved' ? '收藏夹' : '照片库', '', parts.length === 0);
  parts.forEach((part, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    crumbsEl.appendChild(sep);
    mk(part, parts.slice(0, i + 1).join('/'), i === parts.length - 1);
  });
}

function renderFolders() {
  foldersEl.innerHTML = '';
  // 排序：没看完的排前面，按更改日期倒序（新改过的在前）；
  // 看完的排后面，按文件夹名正序
  // （空文件夹没东西可看，算在看完那组）
  const isDone = f => f.count === 0 || (f.viewed || 0) >= f.count;
  const sorted = [...folders].sort((a, b) => {
    const da = isDone(a), db = isDone(b);
    if (da !== db) return da ? 1 : -1;
    if (!da) return (b.mtime || 0) - (a.mtime || 0);
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const f of sorted) {
    const tile = document.createElement('button');
    // 看完的文件夹灰下来，和单张看过变灰一个意思
    const done = isDone(f) && f.count > 0;
    tile.className = 'folder-tile' + (done ? ' viewed' : '');
    // 方块缩略图，和照片网格一个样式：封面是文件夹里按名字排的第一张照片
    const pct = f.count > 0 ? Math.round(((f.viewed || 0) / f.count) * 100) : 0;
    tile.innerHTML =
      (f.cover
        ? `<img loading="lazy" src="/api/thumb?path=${enc(f.cover)}&root=${root}" alt="">`
        : '<span class="fic">📁</span>') +
      `<span class="flabel"><span class="fname">${f.name}</span></span>` +
      // 底部细进度条：已看过的占比，数字就不用了；
      // 没满是黄色，看完了变绿色
      (f.count > 0
        ? `<span class="fprog"><span class="fprog-fill${done ? ' done' : ''}" style="width:${pct}%"></span></span>`
        : '');
    tile.addEventListener('click', () => navigateTo(f.path));
    foldersEl.appendChild(tile);
  }
}

function renderGrid() {
  const vis = visiblePhotos();
  grid.innerHTML = '';
  // 没照片的目录：筛选行和张数行都不显示（只留文件夹和“这里还没有照片”）
  const hasPhotos = allPhotos.length > 0;
  filtersEl.hidden = !hasPhotos;
  countEl.hidden = !hasPhotos;
  // 收藏夹里全是已保存的，“已保存”这颗筛它等于全部，不显示
  const savedBtn = filtersEl.querySelector('button[data-filter="saved"]');
  if (savedBtn) savedBtn.hidden = root === 'saved';
  emptyEl.hidden = vis.length > 0 || folders.length > 0;
  emptyEl.textContent = !hasPhotos && folders.length === 0 && root === 'saved'
    ? '收藏夹还是空的，去照片库上滑保存一张吧'
    : (hasPhotos ? '没有符合条件的照片' : '这里还没有照片');
  for (const [i, p] of vis.entries()) {
    const tile = document.createElement('div');
    // 收藏夹里不描绿边：全是已保存的，再画就是噪音；看过变灰照常
    tile.className = 'tile' + ((root === 'photos' && p.saved) ? ' saved' : '') + (p.viewed ? ' viewed' : '');
    tile.dataset.path = p.path;
    // 状态只用颜色表示，不加字：看过变灰（图片变暗）、保存过描绿边
    tile.innerHTML =
      `<img loading="lazy" src="/api/thumb?path=${enc(p.path)}&root=${root}" alt="">`;
    tile.addEventListener('click', () => openViewer(i));
    grid.appendChild(tile);
  }
  refreshCounts();
  return resumeScroll();
}

// 列表缓存：每个目录拉过一次就记下来。回上级目录时上级一定在缓存里，
// 立刻就能渲染、滑入和幽灵滑出并行，不用等网络——之前卡半秒就是在等拉取
// （根目录要数遍每个子目录的照片，约半秒）。
const listCache = new Map();

function applyListData(data) {
  allPhotos = data.photos;
  folders = data.folders;
  lastViewed = data.lastViewed;
  const warnEl = document.getElementById('list-warning');
  if (data.warning) {
    warnEl.textContent = data.warning;
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
  }
  window.__cullerReady = true;
  const slidingIn = incomingSlide;
  incomingSlide = false;
  // 不是滑入的情况：新列表就绪的同一刻把右滑的位移清掉，和渲染同一帧
  if (!slidingIn) cancelPageDragInstant();
  renderCrumbs();
  renderFolders();
  const didResume = renderGrid();
  if (slidingIn) {
    // 新列表从左侧 -30% 滑进来（位置在手势里已退好，这里只加过渡）
    pageContent.style.transition = 'transform .2s ease-out';
    void pageContent.offsetWidth;  // 强制重排，否则过渡可能不生效
    pageContent.style.transform = '';
    setTimeout(() => { if (pageContent) pageContent.style.transition = ''; }, 220);
  }
  if (pendingRestoreY != null) {
    window.scrollTo(0, pendingRestoreY);  // 回上级目录：回到刚才看的位置
    pendingRestoreY = null;
  } else if (!didResume) {
    window.scrollTo(0, 0);
  }
}

async function loadList() {
  const cached = listCache.get(cacheKey(folder));
  if (cached) {
    applyListData(cached);
    refreshListInBackground();  // 后台拉新的，结构变了再悄悄更新
    return;
  }
  const data = await api(`/api/list?folder=${enc(folder)}&recursive=0&root=${root}`);
  listCache.set(cacheKey(folder), data);
  applyListData(data);
}

// 后台刷新当前目录：只看结构变没变（文件夹、照片有没有增减），
// 已保存/已看这些状态本地已经是对的，不参与比较；
// 更新时不碰滚动位置，正在看的列表不能突然跳走。
async function refreshListInBackground() {
  const target = folder;
  const targetRoot = root;
  try {
    const fresh = await api(`/api/list?folder=${enc(target)}&recursive=0&root=${targetRoot}`);
    if (target !== folder || targetRoot !== root || viewerOpen) return;
    const old = listCache.get(cacheKey(target));
    const sig = d => JSON.stringify([d.folders, d.photos.map(p => p.path)]);
    if (old && sig(fresh) === sig(old)) return;
    if (old) {
      // 本地的已保存/已看状态可能比刚拉回来的新（保存请求还在路上），以本地为准
      const oldByPath = new Map(old.photos.map(p => [p.path, p]));
      for (const p of fresh.photos) {
        const o = oldByPath.get(p.path);
        if (o) {
          if (o.saved) { p.saved = true; p.savedDest = o.savedDest || p.savedDest; }
          if (o.viewed) p.viewed = true;
        }
      }
      // 文件夹的已看数也一样：本地的只会比服务器新（标记完、请求还在路上），
      // 取两边大的那个，后台刷新才不会把进度条又刷回去
      const oldFoldersByPath = new Map((old.folders || []).map(f => [f.path, f]));
      for (const f of fresh.folders) {
        const o = oldFoldersByPath.get(f.path);
        if (o && (o.viewed || 0) > (f.viewed || 0)) f.viewed = o.viewed;
      }
    }
    listCache.set(cacheKey(target), fresh);
    allPhotos = fresh.photos;
    folders = fresh.folders;
    lastViewed = fresh.lastViewed;
    suppressResumeOnce = true;  // 别按“上次看到的照片”跳滚动
    renderCrumbs();
    renderFolders();
    renderGrid();
  } catch { /* 后台刷新失败就静静地用缓存，下次下拉刷新再说 */ }
}

// 记住每个目录离开时的滚动位置，回来时恢复（之前回上级总回到顶部）
const scrollMemory = {};
let pendingRestoreY = null;
let suppressResumeOnce = false;

function navigateTo(target) {
  scrollMemory[scrollKey(folder)] = window.scrollY;
  folder = target;
  viewState[root].folder = target;
  if (scrollMemory[scrollKey(target)] !== undefined) {
    pendingRestoreY = scrollMemory[scrollKey(target)];
    suppressResumeOnce = true;  // 回到看过的位置，不再按“上次看到的照片”定位
  }
  loadList();
}

function goParent() {
  if (!folder) return;
  navigateTo(folder.split('/').slice(0, -1).join('/'));
}

// 上次看到哪张：打开列表时滚动到那张并描个白框；返回 true 表示定位了
function resumeScroll() {
  if (suppressResumeOnce) {
    suppressResumeOnce = false;
    lastViewed = null;
    return false;
  }
  if (!lastViewed) return false;
  const tile = grid.querySelector(`[data-path="${CSS.escape(lastViewed)}"]`);
  if (!tile) { lastViewed = null; return false; }
  tile.classList.add('resume');
  tile.scrollIntoView({ block: 'center' });
  setTimeout(() => tile.classList.remove('resume'), 2500);
  lastViewed = null;  // 只定位一次
  return true;
}

function markViewed(p) {
  if (!p || p.viewed) return;
  p.viewed = true;
  lastViewed = p.path;
  // 已看按视图分开记：服务端用 dest: 前缀区分收藏夹
  post('/api/viewed', { path: p.path, root }).catch(() => {});
  // 文件夹列表的进度也立刻跟上：父目录缓存里对应的文件夹，已看数 +1
  // （不然回上级要等后台刷新拉回来，进度条会晚半拍）
  const parentFolder = p.folder ? p.folder.split('/').slice(0, -1).join('/') : '';
  const parentData = listCache.get(cacheKey(parentFolder));
  if (parentData) {
    const fe = parentData.folders.find(f => f.path === p.folder);
    if (fe && fe.count > 0 && (fe.viewed || 0) < fe.count) fe.viewed = (fe.viewed || 0) + 1;
  }
  const tile = grid.querySelector(`[data-path="${CSS.escape(p.path)}"]`);
  if (tile) tile.classList.add('viewed');  // 变灰即可，不加字
  refreshCounts();
}

// 滑得快一次越过好几张时，把中间路过的也都记成已看过
// （PhotoSwipe 的 change 只对落脚那张发一次，中间那几张不发）
function markViewedRange(from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) markViewed(viewerPhotos[i]);
}

// 只改网格里一张的状态，不整页重绘（看图时保存也不会卡一下）
// 收藏夹视图里不描绿边，改了也看不见，直接跳过
function updateTileSaved(p) {
  if (root === 'saved') { refreshCounts(); return; }
  const tile = grid.querySelector(`[data-path="${CSS.escape(p.path)}"]`);
  if (tile) tile.classList.toggle('saved', p.saved);  // 绿边即可，不加字
  refreshCounts();
}

// 保存一张：存到目标目录下按年的子目录（今年是 2026 就存到 2026/）
// 圆点和 ✓ 立刻出现（乐观反馈），服务器回来了再报具体存到哪；失败则撤回
// 收藏夹视图里不保存：已经是存过的了，上滑只弹一下 ✓、报“已在收藏夹”，
// 不调保存接口、不产生 -1 重复文件
async function savePhoto(p) {
  if (!p) return;
  if (root === 'saved') {
    popSaveConfirm();
    toast('已在收藏夹');
    return;
  }
  if (p.saved) {
    toast(`已在收藏夹：${p.savedDest || ''}`);
    return;
  }
  p.saved = true;
  syncViewerOverlay();
  updateTileSaved(p);
  popSaveConfirm();
  try {
    const r = await post('/api/save', { path: p.path });
    p.savedDest = r.dest;
    toast(r.already ? `已在收藏夹：${r.dest}` : `已保存到 ${r.dest}`);
  } catch (err) {
    p.saved = false;
    p.savedDest = undefined;
    syncViewerOverlay();
    updateTileSaved(p);
    toast('保存失败，请重试');
  }
}

document.querySelectorAll('.filters button[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filters button[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    viewState[root].filter = filter;
    renderGrid();
  });
});

// ---------- 视图切换：照片库 | 收藏夹 ----------
// 两个视图各记各的目录、筛选和滚动位置，切换不丢位置；
// 上次选的视图记在 localStorage，下次打开恢复。
function syncRootSwitchUI() {
  document.querySelectorAll('.root-switch button[data-root]').forEach(b => {
    b.classList.toggle('active', b.dataset.root === root);
  });
  // 收藏夹里“已保存”这颗没意义：切过去时如果正筛着它，回到全部
  if (root === 'saved' && filter === 'saved') {
    filter = 'all';
    viewState.saved.filter = 'all';
    document.querySelectorAll('.filters button[data-filter]').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === 'all');
    });
  }
}

function switchRoot(newRoot) {
  if (newRoot === root || viewerOpen) return;
  scrollMemory[scrollKey(folder)] = window.scrollY;
  viewState[root].folder = folder;
  viewState[root].filter = filter;
  root = newRoot;
  localStorage.setItem('culler-root', root);
  folder = viewState[root].folder;
  filter = viewState[root].filter;
  document.querySelectorAll('.filters button[data-filter]').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  syncRootSwitchUI();
  if (scrollMemory[scrollKey(folder)] !== undefined) {
    pendingRestoreY = scrollMemory[scrollKey(folder)];
    suppressResumeOnce = true;
  }
  window.scrollTo(0, 0);
  loadList();
}

document.querySelectorAll('.root-switch button[data-root]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (view === 'status') showList();
    switchRoot(btn.dataset.root);
  });
});
syncRootSwitchUI();

// ---------- 状态页（v1.18）：顶栏“状态”进去看服务器状态 ----------
// 状态页不是第三个照片视图，只是个查看页：不记 localStorage，不参与
// 目录/筛选/滚动记忆；点回照片库/收藏夹就回到原来的列表。
let view = 'list';  // 'list' | 'status'
const statusPage = document.getElementById('status-page');
const statusBody = document.getElementById('status-body');
const statusRunBtn = document.getElementById('status-run');
const statusBtn = document.querySelector('.root-switch button[data-view="status"]');
let statusPollTimer = null;

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}
function ago(iso) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (mins < 1) return '（刚刚）';
  if (mins < 60) return `（${mins} 分钟前）`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `（${hours} 小时前）`;
  return `（${Math.floor(hours / 24)} 天前）`;
}
function row(k, v, cls) {
  return `<div class="status-row"><span class="k">${k}</span>` +
    `<span class="v${cls ? ' ' + cls : ''}">${v}</span></div>`;
}
// 纯拼 HTML，好测：/api/yandere/status 长什么样，这里就原样显示什么。
function renderStatusHTML(s) {
  const st = s.last_stats;
  const roundState = !st ? '还没跑过'
    : st.aborted ? '中途停下（限流）'
    : st.finished ? '已完成' : '进行中';
  const roundCls = !st ? '' : st.aborted ? 'bad' : st.finished ? 'good' : '';
  const roundNums = !st ? '—'
    : `列表 ${st.lists_ok} 成功 / ${st.lists_failed} 失败 · ` +
      `新抓 ${st.new} · 跳过 ${st.skipped} · 失败 ${st.failed}`;
  const errors = (st && st.errors && st.errors.length)
    ? '<ul class="status-errors">' +
      st.errors.slice(0, 5).map(e => `<li>${esc(e)}</li>`).join('') + '</ul>'
    : '';
  return `<div class="status-section">服务</div><div class="status-card">` +
    row('版本', s.version ? 'PhotoCuller/' + esc(s.version) : '—') +
    row('抓图', s.enabled ? '开' : '关') +
    row('间隔', esc(s.interval_hours) + ' 小时') +
    row('已抓图片', esc(s.seen_count) + ' 张') +
    `</div><div class="status-section">最近一轮</div><div class="status-card">` +
    row('上次开始', fmtTime(s.last_run) + ago(s.last_run)) +
    row('上次成功', s.last_ok ? fmtTime(s.last_ok) + ago(s.last_ok) : '还没成功跑完过') +
    row('下次运行', fmtTime(s.next_run)) +
    row('本轮状态', roundState, roundCls) +
    row('本轮统计', roundNums) +
    row('最近错误', s.last_error ? esc(s.last_error) : '无', s.last_error ? 'bad' : '') +
    `</div>` + errors;
}
async function loadStatus() {
  statusBody.innerHTML = '<div class="status-loading">加载中…</div>';
  try {
    statusBody.innerHTML = renderStatusHTML(await api('/api/yandere/status'));
  } catch (e) {
    statusBody.innerHTML = '<div class="status-error">打不开状态：' +
      esc(e.message) + '。检查容器在不在跑。</div>';
  }
}
function stopStatusPoll() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}
async function runYandereNow() {
  if (statusRunBtn.disabled) return;
  let prevOk = null;
  try { prevOk = (await api('/api/yandere/status')).last_ok; } catch { /* 不挡 */ }
  statusRunBtn.disabled = true;
  statusRunBtn.textContent = '抓图中…';
  try {
    const r = await post('/api/yandere/run', {});
    if (!r.ok) { toast(r.error || '抓图没开始'); return; }
    toast('已开始抓图');
    // 抓图在后台跑（1–2 分钟），每 5 秒看一次状态，跑完就停，最多 3 分钟
    let ticks = 0;
    stopStatusPoll();
    statusPollTimer = setInterval(async () => {
      ticks++;
      if (view !== 'status' || ticks > 36) { stopStatusPoll(); return; }
      try {
        const s = await api('/api/yandere/status');
        statusBody.innerHTML = renderStatusHTML(s);
        if (s.last_ok && s.last_ok !== prevOk) stopStatusPoll();
      } catch { /* 下一轮再试 */ }
    }, 5000);
  } catch (e) {
    toast('抓图没开始：' + e.message);
  } finally {
    statusRunBtn.disabled = false;
    statusRunBtn.textContent = '立即抓图';
  }
}
function showStatus() {
  if (view === 'status') return;
  view = 'status';
  statusPage.hidden = false;
  foldersEl.hidden = true;
  grid.hidden = true;
  emptyEl.hidden = true;
  crumbsEl.hidden = true;
  filtersEl.hidden = true;
  countEl.hidden = true;
  document.getElementById('list-warning').hidden = true;
  document.querySelectorAll('.root-switch button[data-root]').forEach(b => {
    b.classList.remove('active');
  });
  statusBtn.classList.add('active');
  window.scrollTo(0, 0);
  loadStatus();
}
function showList() {
  if (view === 'list') return;
  view = 'list';
  stopStatusPoll();
  statusPage.hidden = true;
  statusBtn.classList.remove('active');
  syncRootSwitchUI();
  loadList();  // 从缓存恢复列表，不用重新拉
}
statusBtn.addEventListener('click', showStatus);
document.getElementById('status-refresh').addEventListener('click', loadStatus);
statusRunBtn.addEventListener('click', runYandereNow);
// 状态页开着时每 30 秒刷新一次；切走了就不刷
setInterval(() => { if (view === 'status') loadStatus(); }, 30000);

// ---------- 列表页手势 ----------
// 右滑回上级目录（带跟手反馈：内容跟着手指右移，左边缘显现“‹ 上级目录”）；
// 在最顶上向下拉是下拉刷新（只重拉列表，不整页重载）。
// 双指触摸不参与手势：第二根手指一落下就取消正在进行的手势，避免误触发。
let pageTouch = null;   // { x, y, mode, pull, atTop }
let ptrRefreshing = false;
// 下拉刷新的触发线：指示条文字贴在条的底部，阈值太小会被灵动岛挡住
const PTR_THRESHOLD = 95;

function resetPageDrag() {
  if (!pageContent) return;
  pageContent.style.transition = 'transform .25s ease';
  pageContent.style.transform = '';
  if (backHint) backHint.style.opacity = '0';
  setTimeout(() => { if (pageContent) pageContent.style.transition = ''; }, 280);
}
function cancelPageDragInstant() {
  if (!pageContent) return;
  pageContent.style.transition = 'none';
  pageContent.style.transform = '';
  if (backHint) backHint.style.opacity = '0';
}

let ghostEl = null;
let incomingSlide = false;

// 回上级目录：旧列表“幽灵层”滑出 + 新列表从左侧滑入
// 之前的做法是旧列表滑出去、等拉回上级目录再渲染，中间空一拍、
// 新列表又是一下子蹦出来，看着就是闪一下。现在两边同时动：
// 旧列表复制一层盖在原位置滑向右，新列表在它下面从左侧 -30% 滑进来，
// 全程没有空档，也没有硬切。
function slideOutToParent(pull) {
  if (backHint) backHint.style.opacity = '0';
  const rect = pageContent.getBoundingClientRect();
  // 幽灵要和滚动恢复后的真实列表上下对齐：回上级后页面会跳到离开时
  // 的滚动位置，真实列表在视口里的 top 会移动 -(目标位置 - 当前位置)；
  // 幽灵的 top 也要跟着减，否则新旧两层在接缝处上下错开，
  // 接缝扫过屏幕中间时看着就是一闪
  const parentPath = folder.split('/').slice(0, -1).join('/');
  const savedY = scrollMemory[scrollKey(parentPath)];
  const destY = savedY !== undefined ? savedY : 0;
  const ghostTop = rect.top - (destY - window.scrollY);
  ghostEl = pageContent.cloneNode(true);
  ghostEl.removeAttribute('id');
  ghostEl.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  ghostEl.style.position = 'fixed';
  ghostEl.style.top = ghostTop + 'px';
  ghostEl.style.left = '0';
  ghostEl.style.right = '0';
  ghostEl.style.zIndex = '5';
  ghostEl.style.background = '#111';
  ghostEl.style.pointerEvents = 'none';
  ghostEl.style.margin = '0';
  // 幽灵从手指松开时的位置开始飞出（translateX(pull)），不断档——
  // 之前这里把位移清掉了，松手瞬间内容会先跳回原位再飞出去，看着就是一闪；
  // ease-out 开头快，接得上手指甩出去的速度
  ghostEl.style.transition = 'none';
  ghostEl.style.transform = `translateX(${pull}px)`;
  document.body.appendChild(ghostEl);
  void ghostEl.offsetWidth;  // 强制重排，让下面的过渡生效
  ghostEl.style.transition = 'transform .25s ease-out';
  ghostEl.style.transform = 'translateX(100%)';
  setTimeout(() => { if (ghostEl) { ghostEl.remove(); ghostEl = null; } }, 280);
  // 真实列表先退到左侧 -30%，上级目录从缓存立刻渲染、滑进来（在 loadList 里接上）
  incomingSlide = true;
  pageContent.style.transition = 'none';
  pageContent.style.transform = 'translateX(-30%)';
  goParent();
}

document.addEventListener('touchstart', e => {
  if (view === 'status') return;  // 状态页不用列表手势（下拉刷新/右滑回上级）
  if (ptrRefreshing) return;
  if (viewerOpen) return;  // 看图器开着时不管
  if (e.touches.length > 1) { cancelPageDragInstant(); pageTouch = null; return; }
  const t = e.changedTouches[0];
  pageTouch = { x: t.clientX, y: t.clientY, mode: null, pull: 0,
                atTop: window.scrollY <= 0 };
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (!pageTouch || ptrRefreshing) return;
  if (viewerOpen) { pageTouch = null; return; }
  if (e.touches.length !== 1) { cancelPageDragInstant(); pageTouch = null; return; }
  const t = e.changedTouches[0];
  const dx = t.clientX - pageTouch.x;
  const dy = t.clientY - pageTouch.y;
  if (!pageTouch.mode) {
    if (dy > 12 && Math.abs(dy) > Math.abs(dx) && pageTouch.atTop) pageTouch.mode = 'ptr';
    else if (dx > 12 && dx > Math.abs(dy) && folder) pageTouch.mode = 'back';
    else return;
  }
  if (pageTouch.mode === 'ptr') {
    // 拉动距离 *0.65，最多拉到指示条完全出来
    const pull = Math.min(dy * 0.65, ptrEl.offsetHeight);
    pageTouch.pull = pull;
    const h = ptrEl.offsetHeight;
    ptrEl.style.transition = 'none';
    ptrEl.style.transform = `translateY(${pull - h}px)`;
    ptrText.textContent = pull >= PTR_THRESHOLD ? '↻ 松开刷新' : '↓ 下拉刷新';
  } else if (pageTouch.mode === 'back') {
    // 右滑回上级：内容跟手右移（0.6 阻尼，最多 140px），提示随距离显现
    const pull = Math.max(0, Math.min(dx * 0.6, 140));
    pageTouch.pull = pull;
    pageContent.style.transition = 'none';
    pageContent.style.transform = `translateX(${pull}px)`;
    if (backHint) backHint.style.opacity = String(Math.min(pull / 60, 1));
  }
}, { passive: true });

document.addEventListener('touchend', async e => {
  if (!pageTouch) return;
  if (e.touches.length > 0) return;  // 还有手指没抬起，不算手势结束
  const { mode, pull, x } = pageTouch;
  const dx = e.changedTouches[0].clientX - x;
  pageTouch = null;
  if (mode === 'ptr') {
    if (pull >= PTR_THRESHOLD && !ptrRefreshing) {
      ptrRefreshing = true;
      ptrText.textContent = '⟳ 刷新中…';
      ptrEl.style.transition = 'transform .2s ease';
      ptrEl.style.transform = 'translateY(0)';
      try {
        listCache.delete(cacheKey(folder));  // 下拉刷新要拉新的，不能用缓存
        await loadList();
        ptrText.textContent = '✓ 已刷新';
      }
      catch { ptrText.textContent = '刷新失败'; }
      setTimeout(() => {
        ptrEl.style.transform = 'translateY(-100%)';
        ptrRefreshing = false;
      }, 600);
    } else {
      ptrEl.style.transition = 'transform .2s ease';
      ptrEl.style.transform = 'translateY(-100%)';
    }
  } else if (mode === 'back') {
    if (dx > 80) {
      // 幽灵从手指松开时的位置开始飞出，不断档（pull 就是当前跟手的位移）
      slideOutToParent(pull);
    } else {
      resetPageDrag();  // 没滑够：弹回原位
    }
  }
}, { passive: true });

// ---------- 看图器 ----------
// 顶部没有任何按钮了：左右滑是前后，上滑存下来，下滑关闭；
// 底部只有一条进度条（看到第几张）+ 一个圆点（存过才显示）。
const lightbox = new PhotoSwipeLightbox({
  pswpModule: () => import('./vendor/photoswipe.esm.js'),
  preload: [2, 3],
  bgOpacity: 1,
  showHideAnimationType: 'fade',
  zoom: true,
  loop: false,  // 看到最后一张就停，不循环回开头
  closeOnVerticalDrag: false,  // 上下滑的手势自己接管：上滑保存、下滑关闭
});

let progressEl = null, progressFill = null, progressDot = null, savePopEl = null;
let viewerOpen = false;  // 看图器是否开着：自己记，不依赖 lightbox.pswp.isOpen
let viewerPhotos = [];   // 看图器打开那一刻的照片快照：看的过程中标记已看会改
                         // visiblePhotos() 的结果（筛“未看过”时列表会缩水），
                         // 索引会错位，所以看图器里只认这份快照
let viewerLastIndex = -1;  // 上一次标记到第几张，滑快了用来补记中间路过的

function currentPhoto() {
  const pswp = lightbox.pswp;
  if (!pswp) return null;
  return viewerPhotos[pswp.currIndex] || null;
}

function buildViewerOverlay() {
  progressEl = document.createElement('div');
  progressEl.className = 'viewer-progress';
  progressEl.innerHTML =
    '<div class="vp-track"><div class="vp-fill"></div></div>' +
    '<span class="vp-dot" hidden></span>';
  lightbox.pswp.element.appendChild(progressEl);
  progressFill = progressEl.querySelector('.vp-fill');
  progressDot = progressEl.querySelector('.vp-dot');

  savePopEl = document.createElement('div');
  savePopEl.className = 'save-pop';
  savePopEl.hidden = true;
  savePopEl.innerHTML = '<span>✓</span>';
  lightbox.pswp.element.appendChild(savePopEl);
}

function syncViewerOverlay() {
  const pswp = lightbox.pswp;
  if (!pswp || !progressEl) return;
  const vis = viewerPhotos;
  const total = vis.length;
  const idx = pswp.currIndex;
  progressFill.style.width = total ? `${((idx + 1) / total) * 100}%` : '0%';
  const p = vis[idx];
  // 收藏夹里不显示圆点：全是已保存的，再画就是噪音
  progressDot.hidden = root === 'saved' || !(p && p.saved);
}

// 上滑保存的 ✓：拖动时随拉动距离慢慢显现，松手存下后弹一下再消失
let savePopHideTimer = null;
function showSavePopPreview(progress) {
  if (!savePopEl) return;
  clearTimeout(savePopHideTimer);  // 别让上一次 hide 的延时把刚显现的 ✓ 又藏掉
  const p = Math.max(0, Math.min(1, progress));
  savePopEl.hidden = false;
  savePopEl.classList.remove('popped');
  savePopEl.style.animation = 'none';
  savePopEl.style.opacity = String(p);
  savePopEl.style.transform = `translate(-50%,-50%) scale(${0.6 + 0.4 * p})`;
}
function hideSavePopPreview() {
  if (!savePopEl) return;
  clearTimeout(savePopHideTimer);
  savePopEl.style.opacity = '0';
  savePopHideTimer = setTimeout(() => { if (savePopEl) savePopEl.hidden = true; }, 180);
}
function popSaveConfirm() {
  if (!savePopEl) return;
  savePopEl.hidden = false;
  savePopEl.style.animation = '';
  savePopEl.classList.remove('popped');
  void savePopEl.offsetWidth;  // 重启动画
  savePopEl.classList.add('popped');
  setTimeout(() => { if (savePopEl) savePopEl.hidden = true; }, 750);
}

function viewerZoomed() {
  const pswp = lightbox.pswp;
  return !!(pswp && pswp.currSlide && pswp.currSlide.currZoomLevel > 1);
}

// 看图器竖直拖动：跟手反馈
// 下滑关闭：图片跟手指下移（0.6 阻尼），松手即关。
// 上滑保存：图片不动，只有中央 ✓ 随拉动距离显现——之前图片跟着上移再弹回，
// 感觉很怪；保存的反馈就是 ✓ 本身，不需要动图片。
// 双指放大（捏合）不参与手势：第二根手指落下就取消竖直拖动，
// 一根手指抬起也不算手势结束——之前捏合时抬起一根手指，dy 会误触发保存。
// 背景透明度绝对不能碰：.pswp__bg 的 CSS 默认 opacity 是 0.005，全靠
// PhotoSwipe 的 applyBgOpacity() 用内联样式维持不透明；直接改
// pswp.bg.style.opacity 再清掉（=''），内联样式一丢背景就变透明，
// 之后每次左右滑列表页都会从背后透出来——v1.4/v1.5/v1.6 的破屏就是这么来的。
// 所以下滑时也只动图片，背景交给 PhotoSwipe 自己管。
let vTouch = null;  // { x, y, axis }
let viewerPinching = false;
let viewerResetTimer = null;

function resetViewerDrag() {
  const pswp = lightbox.pswp;
  if (!pswp) return;
  clearTimeout(viewerResetTimer);
  const wrap = pswp.scrollWrap;
  if (wrap) {
    wrap.style.transition = 'transform .25s ease';
    wrap.style.transform = '';
    viewerResetTimer = setTimeout(() => { if (wrap) wrap.style.transition = ''; }, 280);
  }
  hideSavePopPreview();
}
function resetViewerDragInstant() {
  const pswp = lightbox.pswp;
  if (!pswp) return;
  clearTimeout(viewerResetTimer);
  const wrap = pswp.scrollWrap;
  if (wrap) { wrap.style.transition = 'none'; wrap.style.transform = ''; }
  hideSavePopPreview();
}

function onViewerTouchStart(e) {
  if (e.touches.length > 1) {
    viewerPinching = true;
    vTouch = null;
    resetViewerDragInstant();
    return;
  }
  clearTimeout(viewerResetTimer);
  const t = e.changedTouches[0];
  vTouch = { x: t.clientX, y: t.clientY, axis: null };
}
function onViewerTouchMove(e) {
  const pswp = lightbox.pswp;
  if (!vTouch || !pswp || viewerPinching) return;
  if (e.touches.length !== 1) {  // 第二根手指落下：捏合开始，取消竖直拖动
    viewerPinching = true;
    vTouch = null;
    resetViewerDragInstant();
    return;
  }
  if (viewerZoomed()) return;  // 放大看细节时竖直拖动是平移图片，PhotoSwipe 自己处理
  const t = e.changedTouches[0];
  const dx = t.clientX - vTouch.x;
  const dy = t.clientY - vTouch.y;
  if (!vTouch.axis) {
    // 方向判定要够严：斜着滑时先别定方向，等一方明显占优再定
    if (Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx) * 1.5) vTouch.axis = 'y';
    else if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.5) vTouch.axis = 'x';
    else return;
  }
  if (vTouch.axis === 'y' && Math.abs(dx) > Math.abs(dy) * 1.5) {
    // 竖直拖着拖着转成横向了：立刻把图片恢复干净，交给 PhotoSwipe 横滑
    vTouch.axis = 'x';
    resetViewerDragInstant();
    return;
  }
  if (vTouch.axis !== 'y') return;
  if (dy > 0) {
    // 下滑关闭：图片跟手下移（背景不动，见上面注释）
    const wrap = pswp.scrollWrap;
    wrap.style.transition = 'none';
    wrap.style.transform = `translateY(${dy * 0.6}px)`;
    hideSavePopPreview();
  } else {
    // 上滑保存：图片不动，只有 ✓ 随拉动显现
    const wrap = pswp.scrollWrap;
    wrap.style.transition = 'none';
    wrap.style.transform = '';
    showSavePopPreview((-dy - 30) / 60);
  }
}
function onViewerTouchEnd(e) {
  const pswp = lightbox.pswp;
  if (e.touches.length > 0) return;  // 还有手指没抬起（比如捏合时先抬一根），不算结束
  if (viewerPinching) {
    viewerPinching = false;
    vTouch = null;
    resetViewerDragInstant();
    return;
  }
  if (!vTouch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - vTouch.x;
  const dy = t.clientY - vTouch.y;
  const axis = vTouch.axis;
  vTouch = null;
  if (!pswp) return;
  const zoomed = viewerZoomed();
  if (!zoomed && axis === 'y' && dy > 90) {
    // 下滑关闭：不弹回，直接关——图片保持跟手的位置，关得连贯
    hideSavePopPreview();
    pswp.close();
    return;
  }
  // 其他情况：弹回原位
  resetViewerDrag();
  if (!zoomed && axis === 'y' && dy < -90) savePhoto(currentPhoto());  // 上滑：存下来
}

lightbox.on('afterInit', () => {
  // PhotoSwipe 核心没有 'open' 事件，afterInit 是初始化完成后的一刻，
  // 此时看图器根元素已在页面上，可以挂自己的进度条和手势监听
  viewerOpen = true;
  buildViewerOverlay();
  syncViewerOverlay();
  const el = lightbox.pswp.element;
  el.addEventListener('touchstart', onViewerTouchStart, { passive: true });
  el.addEventListener('touchmove', onViewerTouchMove, { passive: true });
  el.addEventListener('touchend', onViewerTouchEnd, { passive: true });
});
lightbox.on('change', () => {
  syncViewerOverlay();
  // 滑快了可能一次越过好几张：把上次落脚到这次落脚之间路过的全记上
  if (lightbox.pswp) {
    markViewedRange(viewerLastIndex, lightbox.pswp.currIndex);
    viewerLastIndex = lightbox.pswp.currIndex;
  }
});
lightbox.on('close', () => {
  viewerOpen = false;
  const el = lightbox.pswp.element;
  el.removeEventListener('touchstart', onViewerTouchStart);
  el.removeEventListener('touchmove', onViewerTouchMove);
  el.removeEventListener('touchend', onViewerTouchEnd);
  vTouch = null;
  viewerPinching = false;
  clearTimeout(viewerResetTimer);
  if (progressEl) progressEl.remove();
  if (savePopEl) savePopEl.remove();
  progressEl = null;
  savePopEl = null;
});
lightbox.init();

// 键盘：回车保存当前这张（iPad 外接键盘）
document.addEventListener('keydown', e => {
  if (!viewerOpen) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    savePhoto(currentPhoto());
  }
});

function openViewer(index) {
  const vis = visiblePhotos();
  viewerPhotos = vis;       // 先把快照定下来：change 可能在 loadAndOpen 里就发
  viewerLastIndex = index;
  const slides = vis.map(p => {
    // 宽高来自服务端列表，比例一定对；读不出来的不给宽高，让 PhotoSwipe 按原图实测，不猜
    const slide = {
      src: `/api/preview?path=${enc(p.path)}&root=${root}`,
      alt: p.name,
    };
    if (p.width && p.height) {
      slide.width = p.width;
      slide.height = p.height;
    }
    return slide;
  });
  lightbox.loadAndOpen(index, slides);
  markViewed(vis[index]);
  syncViewerOverlay();
}

loadList().catch(err => {
  window.__cullerReady = true;
  incomingSlide = false;
  cancelPageDragInstant();
  emptyEl.hidden = false;
  emptyEl.textContent = '打不开照片目录：' + err.message + '（检查容器里的目录挂载）';
});

// ?view=status 直接进状态页（比如从别处贴个链接就能看）
if (new URLSearchParams(location.search).get('view') === 'status') showStatus();
