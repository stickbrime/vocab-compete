#!/usr/bin/env python3
"""Retry fetching English definitions for words that failed, with longer delays."""
import json
import re
import time
import random
import requests

INPUT = "sentences_100.json"
HEADERS = {"User-Agent": "VocabApp/1.0 (educational; contact: vocab@example.com)"}
session = requests.Session()
session.headers.update(HEADERS)


def from_wiktionary(word):
    url = f"https://en.wiktionary.org/api/rest_v1/page/definition/{word}"
    try:
        r = session.get(url, timeout=25)
        if r.status_code == 429:
            print(f"  Rate limited, waiting 5s...", flush=True)
            time.sleep(5)
            return from_wiktionary(word)
        if r.status_code != 200:
            return ""
        data = r.json()
        en_items = data.get("en", [])
        if isinstance(en_items, dict):
            en_items = [en_items]
        for item in en_items:
            if not isinstance(item, dict):
                continue
            pos = item.get("partOfSpeech", "")
            # Skip symbol/abbreviation entries that aren't real definitions
            if pos in ("Symbol", "Abbreviation", "Initialism", "Proper noun") and word.lower() not in ("pan",):
                continue
            defs = item.get("definitions", [])
            for d in defs:
                if not isinstance(d, dict):
                    continue
                defn = str(d.get("definition", "")).strip()
                defn = re.sub(r"<[^>]+>", "", defn)
                defn = re.sub(r"\s+", " ", defn).strip()
                if len(defn) > 8:
                    return f"[{pos}] {defn}" if pos else defn
    except Exception as e:
        print(f"  Error: {e}", flush=True)
    return ""


def main():
    with open(INPUT, encoding="utf-8") as f:
        data = json.load(f)

    bad = {"", "a fanciful creature of undefined nature", "ISO 639-2 & ISO 639-3 language code for Punjabi."}
    failed = [e for e in data if not e.get("englishDef") or e["englishDef"] in bad or e["englishDef"].startswith("ISO 639")]
    print(f"Retrying {len(failed)} words with long delays...", flush=True)

    for i, entry in enumerate(failed, 1):
        edef = from_wiktionary(entry["word"])
        if edef and edef not in bad and not edef.startswith("ISO 639"):
            entry["englishDef"] = edef
            print(f"[{i}/{len(failed)}] {entry['word']}: {edef[:65]}", flush=True)
        else:
            print(f"[{i}/{len(failed)}] {entry['word']}: FAIL", flush=True)
        with open(INPUT, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # Long delay to avoid rate limiting
        time.sleep(random.uniform(1.2, 2.0))

    good = sum(1 for e in data if e.get("englishDef") and e["englishDef"] not in bad and not e["englishDef"].startswith("ISO 639"))
    print(f"\nTotal: {len(data)} words, {good} with English definitions", flush=True)


if __name__ == "__main__":
    main()
