"""重复扫描回归测试：find_duplicates() 跨目录找一模一样的照片
（同大小才算 SHA-256，哈希按大小+mtime 缓存）。
运行：python3 tests/duplicates_test.py（仓库根目录）。Docker 镜像只 COPY app/，这里不进镜像。"""
import json
import os
import shutil
import sys
from pathlib import Path

BASE = Path("/tmp/duplicates_test")
PHOTOS = BASE / "photos"
DEST = BASE / "dest"
DATA = BASE / "data"

shutil.rmtree(BASE, ignore_errors=True)
PHOTOS.mkdir(parents=True)
(DEST / "2025").mkdir(parents=True)
(DEST / "2026" / "sub").mkdir(parents=True)
DATA.mkdir(parents=True)


def put(rel, data, mtime=None):
    p = DEST / rel
    p.write_bytes(data)
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


X = b"X" * 2000
put("2025/a.jpg", X)
put("2026/b.jpg", X)                 # 和 a 一模一样，跨目录
put("2026/sub/c.jpg", X)             # 同组第三张
put("2025/d.jpg", b"Y" * 2000)       # 同大小、内容不同：算哈希但不入组
put("2026/e.jpg", b"E" * 3000)       # 和 f 同大小、内容不同
put("2026/f.jpg", b"F" * 3000)
put("2025/empty.jpg", b"")           # 0 字节不算照片重复，直接跳过

os.environ["PHOTOS_DIR"] = str(PHOTOS)
os.environ["DEST_DIR"] = str(DEST)
os.environ["DATA_DIR"] = str(DATA)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import server

r = server.find_duplicates("saved")
assert r["ok"] is True, r
assert r["scanned"] == 7, r
assert r["candidates"] == 6, r       # 2000 组 4 张 + 3000 组 2 张；0 字节跳过
assert r["hashed"] == 6 and r["cached"] == 0, r
assert r["duplicate_groups"] == 1 and r["duplicate_photos"] == 3, r
assert r["wasted_bytes"] == 4000, r  # 多出来的 2 份 × 2000
paths = [p["path"] for p in r["photos"]]
assert paths == ["2025/a.jpg", "2026/b.jpg", "2026/sub/c.jpg"], paths
assert all(p["dupGroup"] == 0 and p["dupCount"] == 3 for p in r["photos"]), r["photos"]
# 哈希落盘了
cache = json.loads(server.HASH_FILE.read_text())["saved"]
assert set(cache) == {"2025/a.jpg", "2026/b.jpg", "2026/sub/c.jpg",
                      "2025/d.jpg", "2026/e.jpg", "2026/f.jpg"}, cache

# 第二次扫：全走缓存，不重读原图
r2 = server.find_duplicates("saved")
assert r2["hashed"] == 0 and r2["cached"] == 6, r2
assert [p["path"] for p in r2["photos"]] == paths, r2

# 改一张同大小文件（内容变、mtime 变）：只重算这一张，组不变
d = put("2025/d.jpg", b"Z" * 2000)
st = d.stat()
os.utime(d, (st.st_atime + 100, st.st_mtime + 100))
r3 = server.find_duplicates("saved")
assert r3["hashed"] == 1 and r3["cached"] == 5, r3
assert r3["duplicate_groups"] == 1 and r3["duplicate_photos"] == 3, r3

# 把 b 改成独一无二的大小：组只剩 a、c
put("2026/b.jpg", b"B" * 4000)
r4 = server.find_duplicates("saved")
assert r4["duplicate_groups"] == 1 and r4["duplicate_photos"] == 2, r4
assert r4["wasted_bytes"] == 2000, r4
assert [p["path"] for p in r4["photos"]] == ["2025/a.jpg", "2026/sub/c.jpg"], r4

# 删掉 c：没有重复了；缓存里 b、c 的旧条目也剪掉
(DEST / "2026" / "sub" / "c.jpg").unlink()
r5 = server.find_duplicates("saved")
assert r5["duplicate_groups"] == 0 and r5["duplicate_photos"] == 0, r5
cache5 = json.loads(server.HASH_FILE.read_text())["saved"]
assert "2026/sub/c.jpg" not in cache5 and "2026/b.jpg" not in cache5, cache5

print("ALL DUPLICATES TESTS PASSED")
