#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_sentences.py — 从真实网络来源抓取单词例句（新闻/杂志/维基/语料库）

独立脚本：与网站无关，输出网站可直接导入的 JSON 文件。

用法:
  python3 fetch_sentences.py words.txt out.json
  python3 fetch_sentences.py words.tsv out.json --workers 8
  python3 fetch_sentences.py sat_vocab.json out.json --limit 50
  python3 fetch_sentences.py words.txt out.json --sources gdelt,wiki,tatoeba

输入格式:
  .txt/.tsv   每行一条: word<TAB>词性 释义   或   word 词性 释义   或   仅 word
  .json       [{ "word": ..., "def"|"meaning": ... }, ...]  或  {"items": [...]}

输出 JSON（网站“上传/粘贴创建词集”可直接导入）:
  [{ "word": ..., "def": ..., "sentence": ..., "translation": ..., "src": ... }]

来源优先级:
  1. GDELT 新闻库（全球真实新闻/杂志文章，含出处域名）
  2. Wikipedia 英文词条正文
  3. Tatoeba 语料库（含中文翻译）
  4. DictionaryAPI 词典例句
  5. Glosbe 语料库（含中文翻译）

依赖: requests  →  pip3 install requests
"""

import argparse
import html
import json
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.stderr.write("缺少依赖 requests，请先运行: pip3 install requests\n")
    sys.exit(1)

# ---------------- 配置 ----------------
UA = {"User-Agent": "vocab-sentence-fetcher/1.0 (personal study tool)"}
TIMEOUT = 10
MIN_LEN, MAX_LEN = 35, 220          # 例句长度窗口（字符）
GDELT_MAX_ARTICLES = 6              # 每个词最多抓几篇新闻正文
PRINT_LOCK = threading.Lock()
DEDUP_LOCK = threading.Lock()


def log(*a):
    with PRINT_LOCK:
        print(*a, flush=True)


# ---------------- 词形变化（匹配句中变形） ----------------
def forms_of(w: str):
    w = w.lower().strip()
    forms = {w}
    if re.search(r"(ss|sh|ch|x|z)$", w):
        forms.add(w + "es")
    forms.add(w + "s")
    if w.endswith("y") and len(w) > 2 and w[-2] not in "aeiou":
        forms.add(w[:-1] + "ies")
        forms.add(w[:-1] + "ied")
        forms.add(w[:-1] + "ier")
        forms.add(w[:-1] + "iest")
    if w.endswith("e"):
        forms.add(w + "d")
        forms.add(w[:-1] + "ing")
    forms.add(w + "ed")
    forms.add(w + "ing")
    if len(w) > 1 and re.search(r"[^aeiou][aeiou][^aeiouwxy]$", w):
        forms.add(w + w[-1] + "ed")
        forms.add(w + w[-1] + "ing")
        forms.add(w + w[-1] + "er")
        forms.add(w + w[-1] + "est")
    forms.add(w + "er")
    forms.add(w + "est")
    forms.add(w + "ly")
    return sorted(forms, key=len, reverse=True)


def word_re(w: str):
    pats = [re.escape(f) for f in forms_of(w)]
    return re.compile(r"\b(" + "|".join(pats) + r")", re.IGNORECASE)


# ---------------- 句子质量过滤 ----------------
BAD_RE = re.compile(
    r"(cookie|subscribe|newsletter|sign up|all rights reserved|"
    r"click here|read more|advertisement|©|javascript)", re.I
)


def good_sentence(s: str, wre) -> bool:
    s = s.strip()
    if not (MIN_LEN <= len(s) <= MAX_LEN):
        return False
    if not wre.search(s):
        return False
    if BAD_RE.search(s):
        return False
    if s.count("http") or s.count("www."):
        return False
    letters = sum(c.isalpha() for c in s)
    if letters / max(len(s), 1) < 0.65:
        return False
    upper = sum(c.isupper() for c in s if c.isalpha())
    if letters and upper / letters > 0.5:
        return False
    if not s[0].isupper() and not s[0].isdigit() and s[0] not in '"\'“‘(':
        return False
    if s[-1] not in ".!?\"'”’":
        return False
    return True


def norm_key(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())[:80]


SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'“‘(])")
TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_RE = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)


def html_to_text(raw: str) -> str:
    raw = SCRIPT_RE.sub(" ", raw)
    raw = re.sub(r"<(p|div|br|li|h[1-6])[^>]*>", ". ", raw, flags=re.I)
    raw = TAG_RE.sub(" ", raw)
    raw = html.unescape(raw)
    return re.sub(r"\s+", " ", raw)


def extract_sentences(text: str, wre):
    out = []
    for piece in SENT_SPLIT.split(text):
        piece = piece.strip()
        if good_sentence(piece, wre):
            out.append(piece)
    return out


# ---------------- 来源 1: GDELT（真实新闻/杂志） ----------------
GDELT_SEM = threading.Semaphore(2)  # GDELT 限流：最多 2 并发，避免 429


def fetch_gdelt(w: str, wre, session):
    with GDELT_SEM:
        data = None
        for attempt in range(2):
            try:
                q = requests.utils.quote(f'"{w}" sourcelang:english')
                url = ("https://api.gdeltproject.org/api/v2/doc/doc"
                       f"?query={q}&mode=artlist&maxrecords=15&format=json&sort=hybridrel")
                r = session.get(url, headers=UA, timeout=TIMEOUT)
                if r.status_code == 429:
                    time.sleep(2 + attempt * 2)
                    continue
                if r.status_code != 200:
                    return []
                data = r.json()
                break
            except Exception:
                if attempt == 1:
                    return []
                time.sleep(1)
        if data is None:
            return []
    try:
        articles = data.get("articles", [])
        random.shuffle(articles)
        cands = []
        for art in articles[:GDELT_MAX_ARTICLES]:
            aurl, domain = art.get("url", ""), art.get("domain", "")
            if not aurl:
                continue
            try:
                ar = session.get(aurl, headers=UA, timeout=TIMEOUT)
                if ar.status_code != 200 or len(ar.text) < 500:
                    continue
                text = html_to_text(ar.text)
                for s in extract_sentences(text, wre):
                    cands.append({"sentence": s, "translation": "", "src": domain or "GDELT"})
                if cands:
                    break  # 一篇文章命中即可，换下一个词节省时间
            except Exception:
                continue
            time.sleep(0.2)
        return cands
    except Exception:
        return []


# ---------------- 来源 2: Wikipedia ----------------
def fetch_wiki(w: str, wre, session):
    try:
        r = session.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "query", "list": "search", "srsearch": w,
                    "format": "json", "srlimit": 3},
            headers=UA, timeout=TIMEOUT)
        if r.status_code != 200:
            return []
        hits = r.json().get("query", {}).get("search", [])
        if not hits:
            return []
        ids = "|".join(str(h["pageid"]) for h in hits)
        r2 = session.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "query", "prop": "extracts", "explaintext": 1,
                    "format": "json", "pageids": ids},
            headers=UA, timeout=TIMEOUT)
        if r2.status_code != 200:
            return []
        pages = r2.json().get("query", {}).get("pages", {})
        cands = []
        for pg in pages.values():
            extract = pg.get("extract", "")
            for s in extract_sentences(extract, wre):
                cands.append({"sentence": s, "translation": "",
                              "src": "Wikipedia: " + pg.get("title", "")})
        return cands
    except Exception:
        return []


# ---------------- 来源 3: Tatoeba（含中文翻译） ----------------
def fetch_tatoeba(w: str, wre, session):
    # 两阶段：先限定有中文翻译的结果；为空则放宽到全部英文句
    for params in ({"from": "eng", "to": "cmn", "query": w},
                   {"from": "eng", "query": w}):
        try:
            r = session.get("https://tatoeba.org/en/api_v0/search",
                            params=params, headers=UA, timeout=TIMEOUT)
            if r.status_code != 200:
                continue
            cands = []
            for res in r.json().get("results", []):
                t = (res.get("text") or "").strip()
                if not good_sentence(t, wre):
                    continue
                zh = ""
                for group in res.get("translations", []):
                    for tr in group:
                        if re.search(r"[\u4e00-\u9fff]", tr.get("text", "")):
                            zh = tr["text"]
                            break
                    if zh:
                        break
                cands.append({"sentence": t, "translation": zh, "src": "Tatoeba"})
            if cands:
                return cands
        except Exception:
            continue
    return []


# ---------------- 来源 4: DictionaryAPI ----------------
def fetch_dictapi(w: str, wre, session):
    try:
        r = session.get(f"https://api.dictionaryapi.dev/api/v2/entries/en/{w}",
                        headers=UA, timeout=TIMEOUT)
        if r.status_code != 200:
            return []
        cands = []
        for entry in r.json():
            for meaning in entry.get("meanings", []):
                for d in meaning.get("definitions", []):
                    ex = (d.get("example") or "").strip()
                    if ex and good_sentence(ex, wre):
                        cands.append({"sentence": ex, "translation": "",
                                      "src": "DictionaryAPI"})
        return cands
    except Exception:
        return []


# ---------------- 来源 5: Glosbe（含中文翻译） ----------------
def fetch_glosbe(w: str, wre, session):
    try:
        r = session.get("https://glosbe.com/gapi/translate",
                        params={"from": "en", "dest": "zh", "format": "json",
                                "phrase": w},
                        headers=UA, timeout=TIMEOUT)
        if r.status_code != 200:
            return []
        cands = []
        for ex in r.json().get("examples", []):
            first = (ex.get("first") or "").strip()
            if good_sentence(first, wre):
                cands.append({"sentence": first,
                              "translation": ex.get("second") or "",
                              "src": "Glosbe"})
        return cands
    except Exception:
        return []


SOURCES = {
    "gdelt": fetch_gdelt,
    "wiki": fetch_wiki,
    "tatoeba": fetch_tatoeba,
    "dict": fetch_dictapi,
    "glosbe": fetch_glosbe,
}


# ---------------- 输入解析 ----------------
def load_words(path: str):
    items = []
    if path.lower().endswith(".json"):
        data = json.load(open(path, encoding="utf-8"))
        if isinstance(data, dict):
            data = data.get("items", [])
        for it in data:
            w = (it.get("word") or "").strip()
            if w:
                items.append({"word": w,
                              "def": it.get("def") or it.get("meaning") or ""})
        return items
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        if "\t" in line:
            parts = line.split("\t")
            w, d = parts[0].strip(), parts[1].strip() if len(parts) > 1 else ""
        else:
            m = re.match(r"^([A-Za-z][A-Za-z\-']*)\s+(.+)$", line)
            if m:
                w, d = m.group(1), m.group(2).strip()
            else:
                w, d = line, ""
        w = re.sub(r"^\d+\s*", "", w).strip()  # 去掉编号
        if w and re.match(r"^[A-Za-z][A-Za-z\-']*$", w):
            items.append({"word": w, "def": d})
    return items


# ---------------- 主流程 ----------------
def pick_sentence(word: str, sources, session, used_keys):
    """按来源顺序尝试，返回 (候选句 dict, 来源名) 或 (None, None)。全局去重。"""
    wre = word_re(word)
    for name in sources:
        cands = SOURCES[name](word, wre, session)
        random.shuffle(cands)
        for c in cands:
            k = norm_key(c["sentence"])
            with DEDUP_LOCK:
                if k in used_keys:
                    continue
                used_keys.add(k)
            return c, name
        if name in ("gdelt", "wiki"):  # 礼貌限速
            time.sleep(0.3)
    return None, None


def run(items, sources, workers=6, quiet=False):
    """核心抓取流程：输入 [{word, def}]，返回 ({结果列表}, {统计})。
    quiet=True 时所有日志走 stderr（--stdin 模式保持 stdout 纯净）。"""
    session = requests.Session()
    used_keys = set()
    stats = {name: 0 for name in sources}
    miss, done = [], 0
    results = [None] * len(items)
    emit = (lambda *a: print(*a, file=sys.stderr, flush=True)) if quiet else log

    def work(i, it):
        hit, sname = pick_sentence(it["word"], sources, session, used_keys)
        out = {"word": it["word"], "def": it["def"],
               "sentence": "", "translation": "", "src": ""}
        if hit:
            out.update(hit)
        return i, out, sname

    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(work, i, it) for i, it in enumerate(items)]
            for fut in as_completed(futs):
                i, out, sname = fut.result()
                results[i] = out
                done += 1
                if sname:
                    stats[sname] += 1
                    tag = out["src"]
                else:
                    miss.append(out["word"])
                    tag = "✗ 无例句"
                emit(f"[{done}/{len(items)}] {out['word']:20s} ← {tag}")
    except KeyboardInterrupt:
        emit("\n已中断，写入部分结果…")
    results = [r for r in results if r]
    return results, stats, miss


def main():
    ap = argparse.ArgumentParser(description="从真实网络来源抓取单词例句")
    ap.add_argument("input", nargs="?", help="输入文件: .txt/.tsv/.json")
    ap.add_argument("output", nargs="?", help="输出 JSON 文件（网站可直接导入）")
    ap.add_argument("--stdin", action="store_true",
                    help="从 stdin 读 JSON [{word, def}]，结果 JSON 写 stdout（供服务器调用）")
    ap.add_argument("--workers", type=int, default=6, help="并发数 (默认 6)")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个词 (调试用)")
    ap.add_argument("--sources", default="gdelt,wiki,tatoeba,dict,glosbe",
                    help="来源顺序，逗号分隔 (默认 gdelt,wiki,tatoeba,dict,glosbe)")
    args = ap.parse_args()

    sources = [s.strip() for s in args.sources.split(",") if s.strip() in SOURCES]
    if not sources:
        sys.exit("没有可用的来源: " + args.sources)

    # --stdin 模式：服务器管道调用，stdout 只输出 JSON
    if args.stdin:
        try:
            items = json.load(sys.stdin)
        except Exception:
            sys.exit("stdin 不是有效的 JSON")
        items = [{"word": (it.get("word") or "").strip(),
                  "def": it.get("def") or it.get("meaning") or ""}
                 for it in items if (it.get("word") or "").strip()]
        if not items:
            print("[]")
            return
        results, stats, miss = run(items, sources, workers=min(args.workers, 6), quiet=True)
        print(json.dumps(results, ensure_ascii=False))
        return

    if not args.input or not args.output:
        ap.error("需要 input 和 output 参数（或使用 --stdin）")

    items = load_words(args.input)
    if args.limit:
        items = items[:args.limit]
    if not items:
        sys.exit("输入文件中没有解析到任何单词")

    log(f"共 {len(items)} 个词，来源顺序: {' → '.join(sources)}，并发 {args.workers}")
    results, stats, miss = run(items, sources, workers=args.workers)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    got = [r for r in results if r["sentence"]]
    log("\n===== 完成 =====")
    log(f"输出: {args.output}")
    log(f"成功: {len(got)}/{len(results)}")
    for n, c in stats.items():
        if c:
            log(f"  {n:10s} {c}")
    if miss:
        log(f"未找到例句 ({len(miss)}): {', '.join(miss[:30])}"
            + (" …" if len(miss) > 30 else ""))


if __name__ == "__main__":
    main()
