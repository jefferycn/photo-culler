"""服务端清理回归测试：clean_thumb_cache() 删孤儿缩略图的同时，
把 state.json 里已删照片的记录也剪掉（1.0.5），且挂载故障时不动记录。
运行：python3 tests/cleanup_test.py（仓库根目录）。Docker 镜像只 COPY app/，这里不进镜像。"""
import json
import os
import shutil
import sys
from pathlib import Path

BASE = Path("/tmp/cleanup_test")
PHOTOS = BASE / "photos"
DEST = BASE / "dest"
DATA = BASE / "data"

shutil.rmtree(BASE, ignore_errors=True)
(PHOTOS / "A").mkdir(parents=True)
(PHOTOS / "B").mkdir(parents=True)
(PHOTOS / "D").mkdir(parents=True)  # 空文件夹：模拟挂载掉了、挂载点还在
(DEST / "2026").mkdir(parents=True)
(DATA / ".thumbs").mkdir(parents=True)

from PIL import Image


def jpg(path):
    Image.new("RGB", (8, 8), (200, 30, 40)).save(path, "JPEG")


jpg(PHOTOS / "A" / "1.jpg")
jpg(PHOTOS / "A" / "2.jpg")
jpg(PHOTOS / "B" / "1.jpg")
jpg(PHOTOS / "root.jpg")
jpg(DEST / "2026" / "kept.jpg")

os.environ["PHOTOS_DIR"] = str(PHOTOS)
os.environ["DEST_DIR"] = str(DEST)
os.environ["DATA_DIR"] = str(DATA)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import server

# state.json：混着现存的、已删的、挂载点下（D/）的记录
server._state = {
    "stars": {"B/1.jpg": True, "C/2.jpg": True},
    "saved": {
        "A/1.jpg": "2026/kept.jpg",   # 源和副本都在：留
        "A/2.jpg": "2026/gone.jpg",   # 副本没了：剪
        "C/9.jpg": "2026/kept.jpg",   # 源没了：剪
    },
    "viewed": {
        "A/1.jpg": True,              # 留
        "A/gone.jpg": True,           # A 还在、这张没了：剪
        "C/1.jpg": True,              # C 文件夹整个没了：剪
        "D/1.jpg": True,              # D 还在但空了（疑似挂载掉）：留
        "root.jpg": True,             # 留
        "dest:2026/kept.jpg": True,   # 留
        "dest:2026/gone.jpg": True,   # 2026 还在、这张没了：剪
    },
    "lastViewed": "C/3.jpg",          # 文件夹没了：清掉
    "lastViewedSaved": "2026/kept.jpg",  # 留
}
server.save_state()

# dims.json：一条现存、一条已删文件夹的
mtime_a1 = int((PHOTOS / "A" / "1.jpg").stat().st_mtime)
server._dims = {
    f"photos|A/1.jpg|{mtime_a1}": [8, 8],
    "photos|C/1.jpg|1234567890": [8, 8],
}
server._dims_dirty = True
server.save_dims_if_dirty()

# .thumbs：一对有效的（A/1.jpg 的缩略图+预览图）+ 两个孤儿
server.thumb_path("A/1.jpg", mtime_a1, "photos").write_bytes(b"x" * 100)
server.preview_path("A/1.jpg", mtime_a1, "photos").write_bytes(b"y" * 200)
(DATA / ".thumbs" / "deadbeef01.jpg").write_bytes(b"z" * 50)
(DATA / ".thumbs" / "deadbeef02.jpg").write_bytes(b"z" * 70)

r = server.clean_thumb_cache()
assert r["ok"] is True, r
assert r["deleted"] == 2, r          # 两个孤儿文件
assert r["kept"] == 2, r             # A/1.jpg 的一对缓存
assert r["freed_bytes"] == 120, r
# viewed 剪 3 条（A/gone、C/1、dest:2026/gone）+ stars 1 条 + saved 2 条 + lastViewed 1 条
assert r["state_pruned"] == 7, r
st = server._state
assert st["viewed"] == {"A/1.jpg": True, "D/1.jpg": True, "root.jpg": True,
                        "dest:2026/kept.jpg": True}, st["viewed"]
assert st["stars"] == {"B/1.jpg": True}, st["stars"]
assert st["saved"] == {"A/1.jpg": "2026/kept.jpg"}, st["saved"]
assert st["lastViewed"] is None, st["lastViewed"]
assert st["lastViewedSaved"] == "2026/kept.jpg"
# dims：已删文件夹那条清掉了，现存的还在（list_photos 会顺手把
# 所有现存照片的宽高都读进 _dims，所以这里只断言这两条）
assert "photos|C/1.jpg|1234567890" not in server._dims, server._dims
assert server._dims.get(f"photos|A/1.jpg|{mtime_a1}") == [8, 8], server._dims
# 落盘了：state.json 重新读出来是一样的
assert json.loads(server.STATE_FILE.read_text())["viewed"] == st["viewed"]
# 上次清理记录记下来了（状态页显示用）
assert server._last_cleanup and server._last_cleanup["state_pruned"] == 7
assert server._last_cleanup["time"].endswith("Z")
# 缓存现状现算：2 张、300 字节
assert server.thumb_cache_stats() == {"count": 2, "bytes": 300}

# 根目录空了（整个挂载掉）：照片根的记录全不动，哪怕文件“都不见了”
server._state["viewed"]["A/1.jpg"] = True
server._state["viewed"]["C/1.jpg"] = True
server.PHOTOS_DIR = BASE / "empty_photos"  # 不存在 = 挂载掉了
r2 = server.clean_thumb_cache()
assert "A/1.jpg" in server._state["viewed"], server._state["viewed"]
assert "C/1.jpg" in server._state["viewed"], server._state["viewed"]

print("ALL CLEANUP TESTS PASSED")
