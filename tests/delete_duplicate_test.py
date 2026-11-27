"""重复删除回归测试：delete_duplicate() 只删多余副本，最后一张拒绝，
删完剪掉已看/已保存记录、哈希缓存和缩略图缓存。
运行：python3 tests/delete_duplicate_test.py（仓库根目录）。"""
import json
import os
import shutil
import sys
from pathlib import Path

BASE = Path("/tmp/delete_duplicate_test")
PHOTOS = BASE / "photos"
DEST = BASE / "dest"
DATA = BASE / "data"

shutil.rmtree(BASE, ignore_errors=True)
PHOTOS.mkdir(parents=True)
(DEST / "2025").mkdir(parents=True)
(DEST / "2026").mkdir(parents=True)
(DATA / ".thumbs").mkdir(parents=True)

X = b"X" * 2000
(DEST / "2025" / "a.jpg").write_bytes(X)
(DEST / "2026" / "b.jpg").write_bytes(X)
(DEST / "2026" / "c.jpg").write_bytes(X)
(DEST / "2025" / "solo.jpg").write_bytes(b"S" * 3000)

os.environ["PHOTOS_DIR"] = str(PHOTOS)
os.environ["DEST_DIR"] = str(DEST)
os.environ["DATA_DIR"] = str(DATA)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import server

# 状态里放一条指向 b 的已保存记录 + b 的已看记录，删 b 时应一起剪掉
server._state = {
    "stars": {},
    "saved": {"2026-01-01/x.jpg": "2026/b.jpg"},
    "viewed": {"dest:2026/b.jpg": True, "dest:2025/a.jpg": True},
    "lastViewed": None,
    "lastViewedSaved": "2026/b.jpg",
}
server.save_state()

r0 = server.find_duplicates("saved")
assert r0["duplicate_groups"] == 1 and r0["duplicate_photos"] == 3, r0
b = next(p for p in r0["photos"] if p["path"] == "2026/b.jpg")
# 给 b 放一对缩略图/预览图缓存，删 b 时应顺手清掉
server.thumb_path("2026/b.jpg", b["mtime"], "saved").write_bytes(b"t")
server.preview_path("2026/b.jpg", b["mtime"], "saved").write_bytes(b"p")

# 删 b：组里还剩 2 张，组不消失
r1 = server.delete_duplicate("2026/b.jpg")
assert r1 == {"ok": True, "deleted": "2026/b.jpg",
              "remaining_in_group": 2, "group_removed": False}, r1
assert not (DEST / "2026" / "b.jpg").exists()
assert server._state["saved"] == {}, server._state
assert server._state["viewed"] == {"dest:2025/a.jpg": True}, server._state
assert server._state["lastViewedSaved"] is None, server._state
cache = json.loads(server.HASH_FILE.read_text())["saved"]
assert "2026/b.jpg" not in cache, cache
assert not server.thumb_path("2026/b.jpg", b["mtime"], "saved").exists()
assert not server.preview_path("2026/b.jpg", b["mtime"], "saved").exists()

# 删 a：组里只剩 c 一张，组消失
r2 = server.delete_duplicate("2025/a.jpg")
assert r2["ok"] is True and r2["remaining_in_group"] == 1, r2
assert r2["group_removed"] is True, r2
assert not (DEST / "2025" / "a.jpg").exists()

# 再删 c：已经是最后一张，拒绝，文件留着
r3 = server.delete_duplicate("2026/c.jpg")
assert r3 == {"ok": False, "error": "not_duplicate"}, r3
assert (DEST / "2026" / "c.jpg").exists()

# 本来就不是重复的也拒绝；不存在的文件抛 FileNotFoundError
assert server.delete_duplicate("2025/solo.jpg")["ok"] is False
try:
    server.delete_duplicate("2026/nope.jpg")
    raise AssertionError("should have raised")
except FileNotFoundError:
    pass

# 路径穿越拒绝
try:
    server.delete_duplicate("../photos/x.jpg")
    raise AssertionError("should have raised")
except (ValueError, FileNotFoundError):
    pass

print("ALL DELETE DUPLICATE TESTS PASSED")
