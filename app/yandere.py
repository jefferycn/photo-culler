#!/usr/bin/env python3
"""yandere 抓图（photo-culler v1.17）：把原来群晖上每 12 小时跑一次的 PHP 脚本
``i.php`` 用 Python 标准库重写，放进 photo-culler 容器里一起跑。

按 i.php 的逻辑来：
- 每轮拉 ``popular_by_day.json``（今天、昨天；往前 2-4 天只在对应日期文件夹
  不存在或为空时才回填）和 ``popular_recent.json``，图按 ``<id>.jpg`` 存到
  ``PHOTOS_DIR/<Y-m-d>/``（东京日期，和原来 ``/media/yandere/<Y-m-d>/`` 一样）。
- 去重按 id 全局算（和 i.php 的 retrievedIds 一个意思）：一个 id 只下一次，
  存到它第一次出现的那天文件夹里；之后在别的榜单里再出现就跳过。
  只有当初存的那个文件后来被删了，才会重新下载。

相对 i.php 改掉的、也是原来被限流最可疑的几点：
- 请求之间有间隔（列表 2 秒、图片 1.5 秒，各加 0-1 秒随机抖动），全程串行，
  不再一口气打完；429 读 ``Retry-After`` 退避，退避 3 次还不行就停下本轮、
  等下一轮，不紧循环重试。
- 单张失败只记下来、继续下一张，不杀整轮；列表超时从 5 秒放宽到 15 秒，
  图片超时放宽到 30 秒。
- 状态随抓随存（每处理完一个列表写一次），不再全跑完才写一次；状态文件
  在 ``DATA_DIR/yandere.json``，不在 ``/tmp``（容器重建就没了）。
- 下载先写 ``.tmp``、校验通过才原子改名，坏文件不进图库。

只依赖标准库，不用加依赖。不要拿它直接连真站做测试——测试用本地 mock 站
（见 ``YANDERE_BASE_URL``，默认 ``https://yande.re``）。
"""
import json
import os
import random
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    _TOKYO = ZoneInfo("Asia/Tokyo")
except Exception:  # 容器里没装 tzdata 时退回固定 UTC+9，和东京时间一样
    _TOKYO = timezone(timedelta(hours=9))

USER_AGENT = "photo-culler/1.22"
BASE_URL = "https://yande.re"
MIN_IMAGE_BYTES = 10 * 1024  # 小于 10KB 的“图”基本是错误页，拒收
SEEN_KEEP_DAYS = 45  # 已抓记录只留 45 天，定期清理


class YandereError(Exception):
    """某一轮抓不下去了（比如连续 429），停下本轮、等下一轮。"""


def tokyo_now():
    return datetime.now(_TOKYO)


def _today():
    return tokyo_now().date()


def _date_for(offset):
    return _today() - timedelta(days=offset)


def load_yandere_state(path: Path):
    try:
        st = json.loads(Path(path).read_text())
        if isinstance(st, dict):
            st.setdefault("seen", {})
            return st
    except Exception:
        pass
    return {"seen": {}, "last_run": None, "last_ok": None, "next_run": None,
            "last_stats": None, "last_error": None}


def save_yandere_state(path: Path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    tmp.replace(path)


def _prune_seen(state):
    """已抓记录只留 45 天内的，老的删掉（文件夹本身还在，file_exists 还会兜底）。"""
    cutoff = (_today() - timedelta(days=SEEN_KEEP_DAYS)).isoformat()
    state["seen"] = {k: v for k, v in state.get("seen", {}).items()
                     if isinstance(v, str) and v >= cutoff}


def _folder_has_photos(folder: Path):
    try:
        return any(f.is_file() and f.suffix.lower() in (".jpg", ".jpeg")
                   for f in folder.iterdir())
    except Exception:
        return False


def _sleep(delay, jitter, sleep):
    sleep(delay + random.uniform(0, jitter))


def _http_get(url, timeout, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req, timeout=timeout)


def _fetch_list(url, timeout, sleep, max_429_retries=3):
    """拉一个 JSON 列表。429 按 Retry-After 退避重试；其它错误直接抛给调用方。"""
    wait = 60.0
    for attempt in range(max_429_retries + 1):
        try:
            with _http_get(url, timeout) as resp:
                if resp.status != 200:
                    raise YandereError(f"list {url} -> HTTP {resp.status}")
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max_429_retries:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                try:
                    wait = float(retry_after) if retry_after else wait
                except (TypeError, ValueError):
                    pass
                sleep(min(wait, 3600))
                wait *= 2
                continue
            if e.code == 429:
                raise YandereError(f"list {url} -> 429，退避 3 次还不行，停下本轮")
            raise YandereError(f"list {url} -> HTTP {e.code}")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            raise YandereError(f"list {url} -> {e}")


def _looks_like_jpeg(data: bytes):
    """JPEG 文件头 FF D8、文件尾 FF D9，太小的不要。"""
    return (len(data) >= MIN_IMAGE_BYTES and data[:2] == b"\xff\xd8"
            and data[-2:] == b"\xff\xd9")


def _download_image(url, dest: Path, timeout, sleep, delay, jitter):
    """下一张图。先写 .tmp、校验通过才原子改名。返回 (ok, reason)。"""
    _sleep(delay, jitter, sleep)
    try:
        with _http_get(url, timeout) as resp:
            if resp.status != 200:
                return False, f"HTTP {resp.status}"
            ctype = (resp.headers.get("Content-Type") or "")
            if ctype and not ctype.startswith("image/"):
                return False, f"Content-Type 不是图片：{ctype}"
            data = resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return False, "HTTP 429（本轮不再重试这张，等下一轮）"
        return False, f"HTTP {e.code}"
    except (urllib.error.URLError, TimeoutError) as e:
        return False, str(e)
    if not _looks_like_jpeg(data):
        return False, "内容不是合法 JPEG 或太小"
    tmp = dest.with_suffix(".tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dest)
    except Exception as e:
        try:
            tmp.unlink()
        except Exception:
            pass
        return False, str(e)
    return True, ""


def run_round(photos_dir, state_path, *, base_url=BASE_URL,
              interval_hours=6, days_back=4, list_delay=2.0,
              image_delay=1.5, sleep=time.sleep, now=None):
    """跑一轮抓图。返回统计 dict；同时更新 state 文件（随抓随存）。

    photos_dir 就是 PHOTOS_DIR（原来 /media/yandere 那个目录），
    抓到的图直接写进它的日期子目录。
    """
    photos_dir = Path(photos_dir)
    state = load_yandere_state(state_path)
    _prune_seen(state)
    today = now.date() if now is not None else _today()
    stats = {"started": datetime.now(timezone.utc).isoformat(),
             "lists_ok": 0, "lists_failed": 0, "new": 0,
             "skipped": 0, "failed": 0, "errors": [], "aborted": False}
    new_folders = set()
    seen = state.setdefault("seen", {})

    # 拉哪些天：今天、昨天每轮都拉；往前 2-4 天只在对应文件夹不存在或为空时回填
    offsets = [0, 1]
    for off in range(2, days_back + 1):
        folder = photos_dir / (today - timedelta(days=off)).isoformat()
        if not _folder_has_photos(folder):
            offsets.append(off)
    targets = []
    for off in sorted(offsets, reverse=True):  # 先回填旧的，再拉今天的
        day = today - timedelta(days=off)
        targets.append(("day", day,
                        f"{base_url}/post/popular_by_day.json?"
                        f"day={day.day:02d}&month={day.month:02d}&year={day.year}"))
    targets.append(("recent", today, f"{base_url}/post/popular_recent.json"))

    first = True
    for _kind, day, url in targets:
        if not first:
            _sleep(list_delay, 1.0, sleep)
        first = False
        folder = photos_dir / day.isoformat()
        try:
            pics = _fetch_list(url, timeout=15, sleep=sleep)
        except YandereError as e:
            stats["lists_failed"] += 1
            stats["errors"].append(str(e))
            if "429" in str(e):
                stats["aborted"] = True
                break  # 限流了就停下本轮，别继续打
            continue
        if not isinstance(pics, list):
            stats["lists_failed"] += 1
            stats["errors"].append(f"list {url} -> 返回的不是列表")
            continue
        stats["lists_ok"] += 1
        for pic in pics:
            try:
                pid = str(pic["id"])
                img_url = pic["jpeg_url"]
            except (KeyError, TypeError):
                stats["failed"] += 1
                continue
            dest = folder / f"{pid}.jpg"
            seen_day = seen.get(pid)
            if isinstance(seen_day, str):
                # 全局去重（和 i.php 的 retrievedIds 一个意思）：这个 id 以前抓过，
                # 不管在哪天的榜单里，只要当初存的那个文件还在，就不再重复下；
                # 文件要是后来被删了，就当没抓过，重新下到当前这天的文件夹里。
                # v1.20 的 bug 是只看当天文件夹里有没有这个文件，所以同一张图
                # 在 11/8 榜单里出现过、11/9 又出现，就在两个文件夹各存了一份。
                if (photos_dir / seen_day / f"{pid}.jpg").is_file():
                    stats["skipped"] += 1
                    continue
            if dest.is_file():  # 状态文件丢了也能靠文件去重
                seen[pid] = day.isoformat()
                stats["skipped"] += 1
                continue
            folder.mkdir(parents=True, exist_ok=True)
            ok, reason = _download_image(img_url, dest, timeout=30,
                                         sleep=sleep, delay=image_delay,
                                         jitter=1.0)
            if ok:
                seen[pid] = day.isoformat()
                stats["new"] += 1
                new_folders.add(str(folder))
            else:
                stats["failed"] += 1
                stats["errors"].append(f"{pid}: {reason}")
        # 每处理完一个列表就存一次状态，中途崩了也不丢进度
        state["last_run"] = stats["started"]
        state["last_stats"] = stats
        save_yandere_state(state_path, state)

    stats["finished"] = datetime.now(timezone.utc).isoformat()
    state["last_run"] = stats["started"]
    if not stats["aborted"] and stats["lists_failed"] == 0:
        state["last_ok"] = stats["finished"]
        state["last_error"] = None
    elif stats["errors"]:
        state["last_error"] = stats["errors"][-1]
    state["last_stats"] = stats
    state["next_run"] = (datetime.now(timezone.utc)
                         + timedelta(hours=interval_hours)).isoformat()
    save_yandere_state(state_path, state)
    stats["new_folders"] = sorted(new_folders)
    return stats


def status(state_path, *, enabled=True, interval_hours=6, version=None):
    """给 /api/yandere/status 用的快照。"""
    st = load_yandere_state(state_path)
    return {"version": version, "enabled": enabled,
            "interval_hours": interval_hours,
            "seen_count": len(st.get("seen", {})),
            "last_run": st.get("last_run"), "last_ok": st.get("last_ok"),
            "next_run": st.get("next_run"),
            "last_stats": st.get("last_stats"),
            "last_error": st.get("last_error")}
