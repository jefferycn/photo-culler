#!/usr/bin/env python3
"""Photo culler v1.17 — 在局域网里看 NAS 照片、加星、保存到指定目录。

用法（Docker，见 ../docker-compose.yml）或直接跑：
    PHOTOS_DIR=/path/to/photos DEST_DIR=/path/to/picks DATA_DIR=./data python3 server.py

只依赖标准库 + Pillow（缩略图/预览图用）。默认监听 0.0.0.0:8080，仅限家庭
局域网使用，不要直接暴露到公网。

设计要点：
- PHOTOS_DIR 不再只读挂载：yandere 抓图器（app/yandere.py）要往里面写新图。
  除抓图器外，工具本身不写 PHOTOS_DIR：不删、不覆盖、不移动已有文件；
  保存是复制到目标目录。
- 查看器看的是 2000px 预览图（不是 10–20MB 原图），预加载 + 缓存，滑起来才快。
- 宽高由服务端在列表里一次给全（带缓存），查看器不再猜比例。
"""
import hashlib
import json
import mimetypes
import os
import shutil
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

try:
    from PIL import Image
except ImportError:  # 没有 Pillow 就不生成缩略图，直接用原图
    Image = None

try:
    # 有装 pillow-heif 就能给 HEIC 也做缩略图/预览图；没装也不影响运行
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

PHOTOS_DIR = Path(os.environ.get("PHOTOS_DIR", "/photos")).resolve()
DEST_DIR = Path(os.environ.get("DEST_DIR", "/dest")).resolve()
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
WARM_ON_START = os.environ.get("WARM_ON_START", "1") == "1"
# yandere 抓图（v1.17）：原来 PHP 脚本 i.php 的逻辑，见 app/yandere.py。
# 间隔默认 6 小时，全部可用 .env 控制；YANDERE_BASE_URL 只是测试用的覆盖
# （本地 mock 站），不配就是 https://yande.re。
YANDERE_ENABLED = os.environ.get("YANDERE_ENABLED", "1") == "1"
YANDERE_INTERVAL_HOURS = float(os.environ.get("YANDERE_INTERVAL_HOURS", "6"))
YANDERE_DAYS_BACK = int(os.environ.get("YANDERE_DAYS_BACK", "4"))
YANDERE_LIST_DELAY = float(os.environ.get("YANDERE_LIST_DELAY", "2"))
YANDERE_IMAGE_DELAY = float(os.environ.get("YANDERE_IMAGE_DELAY", "1.5"))
YANDERE_BASE_URL = os.environ.get("YANDERE_BASE_URL", "https://yande.re")
try:
    import yandere
except Exception as e:  # 抓图模块出问题也不影响看图主功能
    yandere = None
    print(f"WARNING: yandere module failed to load: {e}", flush=True)
THUMB_DIR = DATA_DIR / ".thumbs"
STATE_FILE = DATA_DIR / "state.json"
YANDERE_STATE_FILE = DATA_DIR / "yandere.json"
DIMS_FILE = DATA_DIR / "dims.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff",
              ".heic", ".heif"}
THUMB_SIZE = (400, 400)
PREVIEW_SIZE = (2000, 2000)  # 查看器里看的预览图：长边 2000px，放大看也够清楚，体积只有原图的几十分之一
PREVIEW_QUALITY = 82

_lock = threading.Lock()
_state = {"stars": {}, "saved": {}, "viewed": {}, "lastViewed": None,
          "lastViewedSaved": None}
_dims = {}          # {"rel|mtime": [w, h]}
_dims_dirty = False


def load_state():
    global _state
    try:
        _state = json.loads(STATE_FILE.read_text())
        for k, v in {"stars": {}, "saved": {}, "viewed": {}, "lastViewed": None,
                     "lastViewedSaved": None}.items():
            _state.setdefault(k, v)
    except Exception:
        _state = {"stars": {}, "saved": {}, "viewed": {}, "lastViewed": None,
                  "lastViewedSaved": None}


def save_state():
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_state, ensure_ascii=False, indent=1))
    tmp.replace(STATE_FILE)


def load_dims():
    global _dims
    try:
        _dims = json.loads(DIMS_FILE.read_text())
    except Exception:
        _dims = {}


def save_dims_if_dirty():
    global _dims_dirty
    if not _dims_dirty:
        return
    try:
        DIMS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = DIMS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_dims, ensure_ascii=False))
        tmp.replace(DIMS_FILE)
    except Exception:
        pass
    _dims_dirty = False


def root_base(root: str) -> Path:
    """两个视图的根：photos = 源目录（PHOTOS_DIR），saved = 收藏夹（DEST_DIR）。"""
    if root not in ("photos", "saved"):
        raise ValueError("bad root")
    return PHOTOS_DIR if root == "photos" else DEST_DIR


def viewed_key(rel: str, root: str) -> str:
    """已看按视图分开记：源目录用相对路径本身，收藏夹加 dest: 前缀，两边不串。"""
    return rel if root == "photos" else f"dest:{rel}"


def safe_rel(rel: str, root: str = "photos") -> Path:
    """把用户给的相对路径解析成对应视图根目录下的绝对路径，防目录穿越。"""
    base = root_base(root)
    p = (base / unquote(rel)).resolve()
    if p != base and base not in p.parents:
        raise ValueError("path outside root dir")
    return p


def rel_of(p: Path, root: str = "photos") -> str:
    return str(p.relative_to(root_base(root)))


def dims_for(p: Path, rel: str, root: str = "photos"):
    """读图片宽高（只读文件头，不解码全图），结果缓存到 dims.json。失败返回 None。"""
    global _dims_dirty
    if Image is None:
        return None
    key = f"{root}|{rel}|{int(p.stat().st_mtime)}"
    if key in _dims:
        return _dims[key]
    try:
        with Image.open(p) as im:
            size = list(im.size)
    except Exception:
        return None
    _dims[key] = size
    _dims_dirty = True
    return size


def _is_photo(f: Path, root: str = "photos") -> bool:
    """是照片文件，且不在群晖的 @eaDir 这类系统目录里（也不含隐藏文件）。"""
    if not f.is_file():
        return False
    try:
        rel = f.relative_to(root_base(root))
    except ValueError:
        rel = f
    if any(part.startswith(("@", ".")) for part in rel.parts):
        return False
    return f.suffix.lower() in IMAGE_EXTS


def _first_photo(d: Path, root: str = "photos"):
    """文件夹里按文件名排的第一张照片，做目录页的封面缩略图；没有返回 None。"""
    try:
        for f in sorted(d.iterdir(), key=lambda x: x.name):
            if _is_photo(f, root):
                return rel_of(f, root)
    except Exception:
        pass
    return None


def _count_photos(d: Path, root: str = "photos"):
    """文件夹里的照片数（递归）和其中已看过的数；一次遍历同时数出来。"""
    total = 0
    viewed = 0
    try:
        for f in d.rglob("*"):
            if _is_photo(f, root):
                total += 1
                if _state["viewed"].get(viewed_key(rel_of(f, root), root)):
                    viewed += 1
    except Exception:
        pass
    return total, viewed


_library_check = {"at": 0, "has_photos": None, "root": None}


def library_has_photos(root: str = "photos") -> bool:
    """整个照片库里有没有照片（60 秒缓存）。没有就说明目录指错了，页面上要明说，
    不能静悄悄显示空白。收藏夹空是正常的（还没存过），不走这条警告。"""
    now = time.time()
    if (_library_check["has_photos"] is not None and now - _library_check["at"] < 60
            and _library_check["root"] == root):
        return _library_check["has_photos"]
    has = False
    try:
        base = root_base(root)
        if base.is_dir():
            for f in base.rglob("*"):
                if _is_photo(f, root):
                    has = True
                    break
    except Exception:
        has = False
    _library_check.update({"at": now, "has_photos": has, "root": root})
    return has


def list_photos(folder: str, recursive: bool = False, root: str = "photos"):
    """列出 folder 的内容：直接子目录（带递归张数）+ 本层照片（递归时为全部照片）。
    每张照片自带宽高，查看器不再猜比例。单个坏文件/坏目录只跳过，不让整个列表挂掉。
    root=saved 时根是 DEST_DIR，按文件系统实际有什么列什么，不只按 state.json
    里 saved 的记录——手动拷进去的照片也出现。"""
    base = safe_rel(folder, root) if folder else root_base(root)
    if not base.is_dir():
        return [], []
    try:
        entries = list(base.iterdir())
    except Exception:
        entries = []
    folders = []
    for d in sorted((x for x in entries if x.is_dir()
                     and not x.name.startswith((".", "@"))),
                    key=lambda x: x.name):
        try:
            mtime = int(d.stat().st_mtime)
        except Exception:
            mtime = 0
        total, viewed = _count_photos(d, root)
        folders.append({"path": rel_of(d, root), "name": d.name, "count": total,
                        "viewed": viewed, "mtime": mtime, "cover": _first_photo(d, root)})
    it = base.rglob("*") if recursive else base.iterdir()
    photos = []
    for f in sorted(it, key=lambda x: str(x.relative_to(base))):
        try:
            if not _is_photo(f, root):
                continue
            rel = rel_of(f, root)
            st = f.stat()
            dims = dims_for(f, rel, root)
        except Exception:
            continue
        photos.append({
            "path": rel,
            "name": f.name,
            "folder": rel_of(f.parent, root) if f.parent != root_base(root) else "",
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "width": dims[0] if dims else None,
            "height": dims[1] if dims else None,
            "starred": bool(_state["stars"].get(rel)) if root == "photos" else False,
            "saved": True if root == "saved" else rel in _state["saved"],
            "savedDest": rel if root == "saved" else _state["saved"].get(rel),
            "viewed": bool(_state["viewed"].get(viewed_key(rel, root))),
        })
    save_dims_if_dirty()
    return folders, photos


def image_size(p: Path):
    if Image is None:
        return None
    try:
        with Image.open(p) as im:
            return im.size
    except Exception:
        return None


def thumb_path(rel: str, mtime: int, root: str = "photos") -> Path:
    key = hashlib.sha1(f"thumb|{root}|{rel}|{mtime}".encode()).hexdigest()
    return THUMB_DIR / f"{key}.jpg"


def preview_path(rel: str, mtime: int, root: str = "photos") -> Path:
    # key 里带上尺寸：尺寸改了以后旧缓存（1600px）就对不上了，
    # 不带尺寸会一直出旧图；再带上视图，避免源目录和收藏夹同名同 mtime 撞缓存
    key = hashlib.sha1(f"pv2000|{root}|{rel}|{mtime}".encode()).hexdigest()
    return THUMB_DIR / f"{key}.jpg"


def make_thumb(src: Path, rel: str, root: str = "photos"):
    """生成 400px 缩略图并缓存；Pillow 打不开时返回 None。"""
    if Image is None:
        return None
    mtime = int(src.stat().st_mtime)
    dst = thumb_path(rel, mtime, root)
    if dst.exists():
        return dst
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail(THUMB_SIZE, Image.LANCZOS)
            im.save(dst, "JPEG", quality=82)
        return dst
    except Exception:
        return None


def make_preview(src: Path, rel: str, root: str = "photos"):
    """生成查看器用的预览图（长边 2000px），并缓存；做不出来返回 None。"""
    if Image is None:
        return None
    mtime = int(src.stat().st_mtime)
    dst = preview_path(rel, mtime, root)
    if dst.exists():
        return dst
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            if max(im.size) > max(PREVIEW_SIZE):
                im.thumbnail(PREVIEW_SIZE, Image.LANCZOS)
            im.save(dst, "JPEG", quality=PREVIEW_QUALITY)
        return dst
    except Exception:
        return None


def _warm(paths, root: str = "photos"):
    """后台给一批照片生成缩略图和预览图（第一次浏览新目录前跑一次，之后全是缓存）。"""
    for rel in paths:
        try:
            p = safe_rel(rel, root)
            make_thumb(p, rel, root)
            make_preview(p, rel, root)
        except Exception:
            continue


def _warm_all():
    """启动后在后台把全库（照片库 + 收藏夹）的缩略图和预览图都预热一遍。"""
    time.sleep(2)
    try:
        _, photos = list_photos("", recursive=True, root="photos")
        _warm([p["path"] for p in photos], root="photos")
        _, saved = list_photos("", recursive=True, root="saved")
        _warm([p["path"] for p in saved], root="saved")
    except Exception:
        pass


def clean_thumb_cache():
    """删掉孤儿缩略图/预览图：照片库和收藏夹里已经没有的照片（文件夹被删、
    单张被删、改名、mtime 变了），它在 ./data/.thumbs/ 里的缓存就没用了，
    不清会一直涨。
    做法：把现存所有照片的缩略图 + 预览图 key 都算出来当白名单，
    .thumbs 里不在白名单里的 *.jpg 全删——旧版 key（没带 root 前缀、
    1600px 时代的）算出来的旧文件也在白名单外，一并清掉。
    只删 THUMB_DIR 里的 *.jpg，不碰别的；正在预热的新图也在白名单里，
    不会误删；照片在枚举和删文件之间刚被删的，这次留着、下次清。
    顺手把 dims.json 里对不上的旧条目也清掉（只是宽高缓存，缺了会重读）。
    返回删了几个、留了几个、释放了多少字节。"""
    global _dims_dirty
    kept = set()
    try:
        for root in ("photos", "saved"):
            _, photos = list_photos("", recursive=True, root=root)
            for p in photos:
                try:
                    src = safe_rel(p["path"], root)
                    mtime = int(src.stat().st_mtime)
                except Exception:
                    continue
                kept.add(thumb_path(p["path"], mtime, root).name)
                kept.add(preview_path(p["path"], mtime, root).name)
    except Exception:
        return {"ok": False, "deleted": 0, "kept": 0, "freed_bytes": 0}
    deleted = 0
    freed = 0
    total = 0
    if THUMB_DIR.is_dir():
        for f in list(THUMB_DIR.iterdir()):
            if not f.is_file() or f.suffix.lower() != ".jpg":
                continue
            total += 1
            if f.name in kept:
                continue
            try:
                freed += f.stat().st_size
                f.unlink()
                deleted += 1
            except Exception:
                pass
    # dims.json：key 是 "root|相对路径|mtime"（旧版是 "相对路径|mtime"），
    # 文件没了、或者 mtime 对不上（改过、重存过），这条以后再也不会命中，清掉
    try:
        stale = []
        for key in list(_dims):
            parts = key.rsplit("|", 2)
            if len(parts) == 3 and parts[0] in ("photos", "saved"):
                root, rel, mtime = parts
            elif len(parts) == 2:
                root, rel, mtime = "photos", parts[0], parts[1]
            else:
                stale.append(key)
                continue
            try:
                fp = root_base(root) / rel
                if not fp.is_file() or int(mtime) != int(fp.stat().st_mtime):
                    stale.append(key)
            except Exception:
                stale.append(key)
        for key in stale:
            _dims.pop(key, None)
        if stale:
            _dims_dirty = True
            save_dims_if_dirty()
    except Exception:
        pass
    return {"ok": True, "deleted": deleted, "kept": total - deleted,
            "freed_bytes": freed}


def _clean_loop():
    """容器一直跑着、NAS 文件夹后来被删了，也能清掉：启动后先清一次，
    之后每 24 小时清一次。后台跑，不挡页面。"""
    time.sleep(10)
    while True:
        try:
            r = clean_thumb_cache()
            print(f"thumb cleanup: deleted {r['deleted']}, "
                  f"kept {r['kept']}, freed {r['freed_bytes']} bytes", flush=True)
        except Exception:
            pass
        time.sleep(24 * 3600)


# ---------- yandere 抓图（v1.17） ----------
_yandere_lock = threading.Lock()


def _run_yandere_round():
    """跑一轮抓图（定时的和手动的都走这里，锁保证一次只跑一轮）。
    抓完给新文件夹预热缩略图，第二天早上看图直接是缓存。"""
    if yandere is None:
        return None
    with _yandere_lock:
        stats = yandere.run_round(
            PHOTOS_DIR, YANDERE_STATE_FILE, base_url=YANDERE_BASE_URL,
            interval_hours=YANDERE_INTERVAL_HOURS,
            days_back=YANDERE_DAYS_BACK,
            list_delay=YANDERE_LIST_DELAY,
            image_delay=YANDERE_IMAGE_DELAY)
    print(f"yandere: lists ok={stats['lists_ok']} failed={stats['lists_failed']} "
          f"new={stats['new']} skipped={stats['skipped']} "
          f"failed={stats['failed']} aborted={stats['aborted']}", flush=True)
    for folder in stats.get("new_folders", []):
        try:
            rel = str(Path(folder).relative_to(PHOTOS_DIR))
            _, photos = list_photos(rel, recursive=False, root="photos")
            threading.Thread(target=_warm,
                             args=([p["path"] for p in photos], "photos"),
                             daemon=True).start()
        except Exception:
            pass
    return stats


def _yandere_loop():
    """后台定时抓图：启动 60 秒后跑第一轮（先让页面能打开），之后每
    YANDERE_INTERVAL_HOURS 小时跑一轮。"""
    if yandere is None or not YANDERE_ENABLED:
        return
    time.sleep(60)
    while True:
        try:
            _run_yandere_round()
        except Exception as e:
            print(f"yandere round failed: {e}", flush=True)
        time.sleep(YANDERE_INTERVAL_HOURS * 3600)


def year_dest_dir() -> Path:
    """保存目标：按年分子目录，自动算今年是第几年（服务器本地时间）。"""
    d = DEST_DIR / str(datetime.now().year)
    d.mkdir(parents=True, exist_ok=True)
    return d


def dedup_dest(directory: Path, name: str) -> Path:
    """目标目录里重名时加 -1、-2 后缀。"""
    dst = directory / name
    if not dst.exists():
        return dst
    stem, suffix = os.path.splitext(name)
    i = 1
    while True:
        cand = directory / f"{stem}-{i}{suffix}"
        if not cand.exists():
            return cand
        i += 1


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PhotoCuller/1.17"

    def log_message(self, *args):
        pass

    # -- helpers ---------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    def send_file(self, path: Path, ctype: str):
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # 页面和脚本不缓存，避免新旧版本混着用导致页面空白；图片可以长期缓存
        if path.suffix.lower() in (".html", ".js", ".css"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(data)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n) or b"{}")

    # -- routes ----------------------------------------------------------
    def do_HEAD(self):
        self._head_only = True
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                self.send_file(Path(__file__).parent / "static" / "index.html",
                              "text/html; charset=utf-8")
            elif u.path.startswith("/static/"):
                p = (Path(__file__).parent / unquote(u.path[1:])).resolve()
                base = (Path(__file__).parent / "static").resolve()
                if base not in p.parents and p != base:
                    raise ValueError("bad static path")
                ctype, _ = mimetypes.guess_type(str(p))
                self.send_file(p, ctype or "application/octet-stream")
            elif u.path == "/api/list":
                folder = q.get("folder", [""])[0]
                recursive = q.get("recursive", ["0"])[0] == "1"
                root = q.get("root", ["photos"])[0]
                if root not in ("photos", "saved"):
                    raise ValueError("bad root")
                folders, photos = list_photos(folder, recursive, root)
                warning = None
                if root == "photos":
                    if not PHOTOS_DIR.is_dir():
                        warning = f"照片目录不存在：{PHOTOS_DIR}。请检查 .env 里的 PHOTOS_DIR 和挂载。"
                    elif not folders and not photos and not library_has_photos("photos"):
                        warning = f"照片目录 {PHOTOS_DIR} 里一张照片都没有（包括子目录），请检查 PHOTOS_DIR 是不是指错了目录。"
                # root=saved 空是正常的（还没存过），不报黄条，页面只显示空态文字
                self.send_json({"folders": folders, "photos": photos,
                                "total": len(photos), "root": root,
                                "lastViewed": (_state.get("lastViewedSaved")
                                               if root == "saved"
                                               else _state.get("lastViewed")),
                                "warning": warning})
            elif u.path == "/api/dims":
                rel = q.get("path", [""])[0]
                root = q.get("root", ["photos"])[0]
                p = safe_rel(rel, root)
                size = image_size(p)
                self.send_json({"path": rel, "width": size[0] if size else None,
                                "height": size[1] if size else None})
            elif u.path == "/api/thumb":
                rel = q.get("path", [""])[0]
                root = q.get("root", ["photos"])[0]
                p = safe_rel(rel, root)
                t = make_thumb(p, rel, root)
                if t is not None:
                    self.send_file(t, "image/jpeg")
                else:  # 缩略图做不出来就直接给原图，浏览器自己缩放
                    ctype, _ = mimetypes.guess_type(str(p))
                    self.send_file(p, ctype or "application/octet-stream")
            elif u.path == "/api/preview":
                # 查看器用的图：2000px 预览，局域网里几十毫秒就到；做不出来就给原图
                rel = q.get("path", [""])[0]
                root = q.get("root", ["photos"])[0]
                p = safe_rel(rel, root)
                pv = make_preview(p, rel, root)
                if pv is not None:
                    self.send_file(pv, "image/jpeg")
                else:
                    ctype, _ = mimetypes.guess_type(str(p))
                    self.send_file(p, ctype or "application/octet-stream")
            elif u.path == "/api/photo":
                rel = q.get("path", [""])[0]
                root = q.get("root", ["photos"])[0]
                p = safe_rel(rel, root)
                ctype, _ = mimetypes.guess_type(str(p))
                self.send_file(p, ctype or "application/octet-stream")
            elif u.path == "/api/state":
                self.send_json(_state)
            elif u.path == "/api/yandere/status":
                if yandere is None:
                    self.send_json({"enabled": False, "error": "yandere module not loaded"})
                else:
                    self.send_json(yandere.status(
                        YANDERE_STATE_FILE, enabled=YANDERE_ENABLED,
                        interval_hours=YANDERE_INTERVAL_HOURS))
            else:
                self.send_error(404)
        except (ValueError, FileNotFoundError):
            self.send_json({"error": "not found"}, 404)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            if u.path == "/api/star":
                body = self.read_json()
                rel, starred = body["path"], bool(body.get("starred"))
                safe_rel(rel)  # 只校验路径合法
                with _lock:
                    if starred:
                        _state["stars"][rel] = True
                    else:
                        _state["stars"].pop(rel, None)
                    save_state()
                self.send_json({"ok": True, "path": rel, "starred": starred})
            elif u.path == "/api/viewed":
                # 看过一张就记一张，下次打开能续看、网格里也能看到哪些看过了
                # 已看按视图分开记：body 可带 root=saved，或 path 带 dest: 前缀
                body = self.read_json()
                rel = body["path"]
                root = body.get("root", "photos")
                if rel.startswith("dest:"):
                    root = "saved"
                    rel = rel[len("dest:"):]
                if root not in ("photos", "saved"):
                    raise ValueError("bad root")
                safe_rel(rel, root)
                with _lock:
                    _state["viewed"][viewed_key(rel, root)] = True
                    if root == "saved":
                        _state["lastViewedSaved"] = rel
                    else:
                        _state["lastViewed"] = rel
                    save_state()
                self.send_json({"ok": True, "path": rel, "root": root})
            elif u.path == "/api/save":
                body = self.read_json()
                rel = body["path"]
                src = safe_rel(rel)
                if not src.is_file():
                    raise FileNotFoundError(rel)
                year_dir = year_dest_dir()
                with _lock:
                    if rel in _state["saved"]:
                        self.send_json({"ok": True, "already": True,
                                        "dest": _state["saved"][rel]})
                        return
                    dst = dedup_dest(year_dir, src.name)
                    shutil.copy2(src, dst)
                    _state["saved"][rel] = f"{year_dir.name}/{dst.name}"
                    save_state()
                self.send_json({"ok": True, "already": False,
                                "dest": f"{year_dir.name}/{dst.name}"})
            elif u.path == "/api/save-all":
                copied, skipped = [], []
                year_dir = year_dest_dir()
                with _lock:
                    for rel in sorted(_state["stars"]):
                        if rel in _state["saved"]:
                            skipped.append(rel)
                            continue
                        src = safe_rel(rel)
                        if not src.is_file():
                            skipped.append(rel)
                            continue
                        dst = dedup_dest(year_dir, src.name)
                        shutil.copy2(src, dst)
                        _state["saved"][rel] = f"{year_dir.name}/{dst.name}"
                        copied.append(f"{year_dir.name}/{dst.name}")
                    save_state()
                self.send_json({"ok": True, "copied": copied, "skipped": skipped})
            elif u.path == "/api/clean-thumbs":
                # 手动清一次孤儿缩略图/预览图（NAS 上删了文件夹/照片后），
                # 返回删了几个、留了几个、释放了多少字节；启动后和每天也会自动清
                self.send_json(clean_thumb_cache())
            elif u.path == "/api/yandere/run":
                # 手动立刻跑一轮抓图：后台跑，不等它跑完（可能要 1-2 分钟），
                # 跑完的状态用 GET /api/yandere/status 看
                if yandere is None or not YANDERE_ENABLED:
                    self.send_json({"ok": False,
                                    "error": "yandere disabled or not loaded"})
                    return
                if _yandere_lock.locked():
                    self.send_json({"ok": False, "error": "already running"})
                    return
                threading.Thread(target=_run_yandere_round, daemon=True).start()
                self.send_json({"ok": True, "started": True})
            elif u.path == "/api/warm":
                # 后台预生成当前目录下所有照片的缩略图和预览图，生成完之前浏览也不受影响
                body = self.read_json()
                folder = body.get("folder", "")
                recursive = bool(body.get("recursive"))
                root = body.get("root", "photos")
                if root not in ("photos", "saved"):
                    raise ValueError("bad root")
                _, photos = list_photos(folder, recursive, root)
                threading.Thread(target=_warm,
                                 args=([p["path"] for p in photos], root),
                                 daemon=True).start()
                self.send_json({"ok": True, "total": len(photos)})
            else:
                self.send_error(404)
        except (ValueError, FileNotFoundError, KeyError):
            self.send_json({"error": "bad request"}, 400)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DEST_DIR.mkdir(parents=True, exist_ok=True)
    load_state()
    load_dims()
    print(f"photos: {PHOTOS_DIR}\ndest:   {DEST_DIR}\ndata:   {DATA_DIR}")
    if not PHOTOS_DIR.is_dir():
        print(f"WARNING: 照片目录不存在：{PHOTOS_DIR}，请检查 PHOTOS_DIR / .env，页面会是空白的！")
    elif not library_has_photos():
        print(f"WARNING: 照片目录 {PHOTOS_DIR} 里没有照片，页面会是空白的！")
    print(f"listening on http://{HOST}:{PORT}  （局域网内访问）")
    # 孤儿缩略图清理：启动后清一次，之后每 24 小时清一次（后台线程，不挡页面）
    threading.Thread(target=_clean_loop, daemon=True).start()
    # yandere 抓图：启动 60 秒后跑第一轮，之后每 YANDERE_INTERVAL_HOURS 小时一轮
    threading.Thread(target=_yandere_loop, daemon=True).start()
    if WARM_ON_START:
        threading.Thread(target=_warm_all, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
