"""移动回归测试：move_photo() 在收藏夹内换目录，重名加后缀，
已看/已保存/哈希/缩略图缓存跟着新路径走；同目录拒绝、坏目录拒绝。
运行：python3 tests/move_test.py（仓库根目录）。"""
import json
import os
import shutil
import sys
from pathlib import Path

BASE = Path("/tmp/move_test")
PHOTOS = BASE / "photos"
DEST = BASE / "dest"
DATA = BASE / "data"

shutil.rmtree(BASE, ignore_errors=True)
PHOTOS.mkdir(parents=True)
(DEST / "2025").mkdir(parents=True)
(DEST / "2026" / "sub").mkdir(parents=True)
(DATA / ".thumbs").mkdir(parents=True)

X = b"X" * 2000
(DEST / "2025" / "a.jpg").write_bytes(X)
(DEST / "2026" / "a.jpg").write_bytes(b"Y" * 2000)  # 同名不同内容：移动时要加后缀
(DEST / "2026" / "b.jpg").write_bytes(X)            # 和 2025/a 是重复组

os.environ["PHOTOS_DIR"] = str(PHOTOS)
os.environ["DEST_DIR"] = str(DEST)
os.environ["DATA_DIR"] = str(DATA)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import server

assert server.list_folders("saved") == ["2025", "2026", "2026/sub"]

server._state = {
    "stars": {},
    "saved": {"2026-01-01/x.jpg": "2025/a.jpg"},
    "viewed": {"dest:2025/a.jpg": True},
    "lastViewed": None,
    "lastViewedSaved": "2025/a.jpg",
}
server.save_state()

# 先扫一遍重复，让哈希缓存里有 2025/a 的条目；再给它放一对缩略图缓存
r0 = server.find_duplicates("saved")
assert r0["duplicate_groups"] == 1, r0
a = next(p for p in r0["photos"] if p["path"] == "2025/a.jpg")
server.thumb_path("2025/a.jpg", a["mtime"], "saved").write_bytes(b"t")
server.preview_path("2025/a.jpg", a["mtime"], "saved").write_bytes(b"p")

# 移到 2026：已有同名 a.jpg，后缀成 a-1.jpg
r1 = server.move_photo("2025/a.jpg", "2026")
assert r1 == {"ok": True, "from": "2025/a.jpg", "to": "2026/a-1.jpg",
              "destFolder": "2026"}, r1
assert not (DEST / "2025" / "a.jpg").exists()
assert (DEST / "2026" / "a-1.jpg").read_bytes() == X
assert server._state["saved"] == {"2026-01-01/x.jpg": "2026/a-1.jpg"}, server._state
assert server._state["viewed"] == {"dest:2026/a-1.jpg": True}, server._state
assert server._state["lastViewedSaved"] == "2026/a-1.jpg", server._state
cache = json.loads(server.HASH_FILE.read_text())["saved"]
assert "2025/a.jpg" not in cache and "2026/a-1.jpg" in cache, cache
new_mtime = int((DEST / "2026" / "a-1.jpg").stat().st_mtime)
assert server.thumb_path("2026/a-1.jpg", new_mtime, "saved").exists()
assert not server.thumb_path("2025/a.jpg", a["mtime"], "saved").exists()
# 移动不改变重复关系：a-1 和 b 仍是一组
r1b = server.find_duplicates("saved")
assert [p["path"] for p in r1b["photos"]] == ["2026/a-1.jpg", "2026/b.jpg"], r1b

# 移到当前目录：拒绝，文件不动
r2 = server.move_photo("2026/a-1.jpg", "2026")
assert r2 == {"ok": False, "error": "same_folder"}, r2
assert (DEST / "2026" / "a-1.jpg").exists()

# 移到根目录
r3 = server.move_photo("2026/b.jpg", "")
assert r3["ok"] is True and r3["to"] == "b.jpg", r3
assert (DEST / "b.jpg").exists()

# 不存在的目录 / 不存在的照片 / 路径穿越：拒绝
for rel, dest in [("2026/a-1.jpg", "2099"), ("2026/nope.jpg", "2025")]:
    try:
        server.move_photo(rel, dest)
        raise AssertionError(f"should have raised: {rel} -> {dest}")
    except FileNotFoundError:
        pass
try:
    server.move_photo("2026/a-1.jpg", "../photos")
    raise AssertionError("should have raised")
except (ValueError, FileNotFoundError):
    pass

print("ALL MOVE TESTS PASSED")
