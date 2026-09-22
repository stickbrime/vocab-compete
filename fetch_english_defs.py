#!/usr/bin/env python3
"""Fetch English definitions for all 100 words from Wiktionary (free, no key).
Saves results into sentences_100.json as 'englishDef' field.
"""
import json
import re
import time
import random
import requests

INPUT = "sentences_100.json"
HEADERS = {"User-Agent": "VocabApp/1.0 (educational)"}
session = requests.Session()
session.headers.update(HEADERS)


def from_wiktionary(word):
    """Wiktionary REST API: https://en.wiktionary.org/api/rest_v1/page/definition/{word}"""
    url = f"https://en.wiktionary.org/api/rest_v1/page/definition/{word}"
    try:
        r = session.get(url, timeout=20)
        if r.status_code != 200:
            return ""
        data = r.json()
        # data is {lang: [items]}; we want English
        en_items = data.get("en", [])
        if isinstance(en_items, dict):
            en_items = [en_items]
        for item in en_items:
            if not isinstance(item, dict):
                continue
            pos = item.get("partOfSpeech", "")
            defs = item.get("definitions", [])
            for d in defs:
                if not isinstance(d, dict):
                    continue
                defn = str(d.get("definition", "")).strip()
                defn = re.sub(r"<[^>]+>", "", defn)  # strip HTML
                # Skip very short or non-definition entries
                if len(defn) > 8:
                    return f"[{pos}] {defn}" if pos else defn
    except Exception:
        pass
    return ""


def main():
    with open(INPUT, encoding="utf-8") as f:
        data = json.load(f)

    done = 0
    for entry in data:
        if entry.get("englishDef") and entry["englishDef"] not in ("", "a fanciful creature of undefined nature"):
            done += 1
            continue
        edef = from_wiktionary(entry["word"])
        # Clear the bad value if present
        if edef == "a fanciful creature of undefined nature":
            edef = ""
        entry["englishDef"] = edef
        done += 1
        status = edef[:70] if edef else "FAIL"
        print(f"[{done}/{len(data)}] {entry['word']}: {status}", flush=True)
        with open(INPUT, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        time.sleep(random.uniform(0.2, 0.4))

    with_def = sum(1 for r in data if r.get("englishDef") and r["englishDef"] != "a fanciful creature of undefined nature")
    print(f"\nDone: {len(data)} words, {with_def} with English definitions")


if __name__ == "__main__":
    main()
