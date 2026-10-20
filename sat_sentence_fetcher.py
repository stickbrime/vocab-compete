#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sat_sentence_fetcher.py
=======================
Fetch REAL example sentences (from published media / books, not AI-generated)
for a list of vocabulary words, and export structured JSON for the
SAT vocab challenge webpage (vocabData format).

USAGE
-----
    pip install requests beautifulsoup4

    # input: one word per line, OR tab-separated "word<TAB>meaning"
    python sat_sentence_fetcher.py -i words.txt -o sentences.json

    # resume a previous run (cache skips already-fetched words)
    python sat_sentence_fetcher.py -i words.txt -o sentences.json --cache cache.jsonl

    # merge fetched sentences with an existing wordlist (adds s/src fields)
    python sat_sentence_fetcher.py -i words.tsv -o merged.json --merge

OUTPUT (sentences.json)
-----------------------
[
  {"w": "mollify", "m": "v. ...",            # meaning (if given in input)
   "s": "They are not mollified by a plan...",  # example sentence
   "src": "The Economist 2017 (via Merriam-Webster)",
   "t": "", "en": ""},                       # fill t/en manually or via --merge
  ...
]

NOTE
----
- Sources: Merriam-Webster "Examples on the Web" (aggregated from NYT, CNN,
  The Economist, Vogue, etc.) with a Vocabulary.com fallback.
- Be polite: keep --sleep >= 1.0 s between requests. Sites may change their
  HTML layout; if parsing returns nothing, update SELECTORS below.
"""

import argparse
import json
import os
import random
import re
import sys
import time
from urllib.parse import quote

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Please run:  pip install requests beautifulsoup4")

UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0 Safari/537.36",
]

# ---------------------------------------------------------------------------
# Parsers: each returns a list of dicts: {"s": sentence, "src": source}
# ---------------------------------------------------------------------------

def parse_merriam_webster(html: str):
    """Parse 'Recent Examples on the Web' from merriam-webster.com."""
    soup = BeautifulSoup(html, "html.parser")
    out = []

    # Section heading anchor used by MW
    anchor = soup.find(id="example-sentences") or soup.find(id="medicalDictionary")
    # Primary container for web examples
    container = None
    for sel in [".on-web", ".examples-on-web", "div.in-sentences"]:
        container = soup.select_one(sel)
        if container:
            break
    if not container:
        # fallback: any paragraph whose class contains 'ex-sent'
        container = soup

    items = container.select(".ex-sent") or container.select("p.t") or []
    for it in items:
        # sentence text lives in span.t or the <em>/text nodes
        txt = it.get_text(" ", strip=True)
        txt = re.sub(r"^[:\"]+|\"$", "", txt).strip()
        if len(txt) < 15 or len(txt) > 500:
            continue
        # source: sibling/child span.auth or cite
        src = ""
        auth = it.find_next(["span", "cite"], class_=re.compile("auth|source", re.I))
        if auth:
            src = auth.get_text(" ", strip=True)
        # drop the trailing em-dash attribution inside sentence
        txt = re.sub(r"\s+—\s+[A-Z][^.]*$", "", txt).strip()
        if txt:
            out.append({"s": txt, "src": (src + "（Merriam-Webster 收录）").strip("（）")
                        if src else "Merriam-Webster 例句"})
        if len(out) >= 5:
            break
    return out


def parse_vocabulary_com(html: str):
    """Fallback: example sentences from vocabulary.com dictionary pages."""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    # 2026 layout: examples live directly in <div class="example">
    selectors = ["div.example", ".example .text", ".definition .example", "p.block DefText"]
    for sel in selectors:
        els = soup.select(sel)
        if not els:
            continue
        for el in els[:5]:
            txt = el.get_text(" ", strip=True)
            txt = txt.strip("“”\"' ").strip()
            if 25 <= len(txt) <= 400:  # skip bare fragments like "his candid eyes"
                out.append({"s": txt, "src": "Vocabulary.com 例句库"})
        if out:
            break
    return out


SOURCES = [
    ("merriam-webster",
     lambda w: f"https://www.merriam-webster.com/dictionary/{quote(w)}",
     parse_merriam_webster),
    ("vocabulary.com",
     lambda w: f"https://www.vocabulary.com/dictionary/{quote(w)}",
     parse_vocabulary_com),
]

# ---------------------------------------------------------------------------
# Core fetching
# ---------------------------------------------------------------------------

class Fetcher:
    def __init__(self, sleep=1.5, cache_path=None):
        self.sleep = sleep
        self.cache_path = cache_path
        self.session = requests.Session()
        self.cache = {}
        if cache_path and os.path.exists(cache_path):
            with open(cache_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                        self.cache[rec["w"]] = rec["hits"]
                    except Exception:
                        pass

    def _get(self, url, tries=3):
        for i in range(tries):
            try:
                r = self.session.get(url, headers={"User-Agent": random.choice(UA_POOL)},
                                     timeout=15)
                if r.status_code == 200:
                    return r.text
                if r.status_code in (403, 404):
                    return None  # bot-blocked or missing — don't waste retries
            except requests.RequestException:
                pass
            time.sleep(2 * (i + 1))
        return None

    def fetch_word(self, word):
        """Return list of {'s','src'} across all sources."""
        if word in self.cache:
            return self.cache[word]
        hits = []
        for name, url_fn, parser in SOURCES:
            html = self._get(url_fn(word))
            time.sleep(self.sleep + random.random())
            if not html:
                continue
            hits = parser(html)
            if hits:
                break
        self.cache[word] = hits
        if self.cache_path:
            with open(self.cache_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"w": word, "hits": hits}, ensure_ascii=False) + "\n")
        return hits


def read_input(path):
    """Return list of {'w','m'} accepting plain wordlist or TSV."""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            rows.append({"w": parts[0].strip(), "m": parts[1].strip() if len(parts) > 1 else ""})
    return rows


def run_stdin(sleep=1.2):
    """Server mode: read [{word, def}] JSON from stdin, write results to stdout.
    Output format matches the website generator: {word, def, sentence, translation, src}.
    Progress logs go to stderr to keep stdout pure JSON."""
    import sys as _sys
    try:
        rows = json.load(_sys.stdin)
    except Exception:
        _sys.exit("stdin is not valid JSON")
    words = []
    for it in rows:
        w = (it.get("word") or it.get("w") or "").strip()
        if w:
            words.append({"w": w, "m": (it.get("def") or it.get("m") or "").strip()})
    if not words:
        print("[]")
        return
    fx = Fetcher(sleep=sleep)
    results = []
    for idx, row in enumerate(words, 1):
        hits = fx.fetch_word(row["w"])
        if hits:
            results.append({"word": row["w"], "def": row["m"],
                            "sentence": hits[0]["s"], "translation": "",
                            "src": hits[0]["src"]})
            print(f"[{idx}/{len(words)}] OK   {row['w']}  <- {hits[0]['src']}",
                  file=_sys.stderr, flush=True)
        else:
            results.append({"word": row["w"], "def": row["m"],
                            "sentence": "", "translation": "", "src": ""})
            print(f"[{idx}/{len(words)}] FAIL {row['w']}", file=_sys.stderr, flush=True)
    print(json.dumps(results, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description="Fetch real example sentences for vocab words.")
    ap.add_argument("-i", "--input", default=None, help="wordlist file (word per line or TSV)")
    ap.add_argument("-o", "--output", default=None, help="output JSON file")
    ap.add_argument("--stdin", action="store_true",
                    help="server mode: [{word, def}] JSON in, results JSON out")
    ap.add_argument("--sleep", type=float, default=1.5, help="seconds between requests")
    ap.add_argument("--cache", default=None, help="JSONL cache path for resume")
    ap.add_argument("--per-word", type=int, default=1, help="sentences to keep per word")
    args = ap.parse_args()

    if args.stdin:
        run_stdin(sleep=min(args.sleep, 1.5))
        return

    if not args.input or not args.output:
        ap.error("-i/--input and -o/--output are required (or use --stdin)")

    rows = read_input(args.input)
    fx = Fetcher(sleep=args.sleep, cache_path=args.cache)
    results, failed = [], []

    for idx, row in enumerate(rows, 1):
        w = row["w"]
        hits = fx.fetch_word(w)
        if hits:
            for h in hits[:args.per_word]:
                results.append({"w": w, "m": row["m"],
                                "s": h["s"], "src": h["src"],
                                "t": "", "en": ""})
            print(f"[{idx}/{len(rows)}] OK   {w}  <- {hits[0]['src']}")
        else:
            failed.append(w)
            print(f"[{idx}/{len(rows)}] FAIL {w}")

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)

    print(f"\nSaved {len(results)} records to {args.output}")
    if failed:
        print("No sentence found for:", ", ".join(failed))
        print("(You can re-run with --cache later; failed words are simply absent.)")


if __name__ == "__main__":
    main()
