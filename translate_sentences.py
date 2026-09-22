#!/usr/bin/env python3
"""Translate the example sentences in sentences_100.json using MyMemory free API."""
import json
import time
import random
import requests

INPUT = "sentences_100.json"
OUTPUT = "sentences_100.json"
TSV_OUTPUT = "vocab_100_with_sentences.tsv"

session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})


def translate(text):
    if not text:
        return ""
    url = "https://api.mymemory.translated.net/get"
    params = {"q": text, "langpair": "en|zh-CN"}
    try:
        r = session.get(url, params=params, timeout=20)
        if r.status_code != 200:
            return ""
        data = r.json()
        t = data.get("responseData", {}).get("translatedText", "")
        return t.strip()
    except Exception:
        return ""


def main():
    with open(INPUT, encoding="utf-8") as f:
        data = json.load(f)

    done = 0
    for entry in data:
        if entry.get("translation"):
            done += 1
            continue
        # Translate the original sentence (un-blank it)
        original = entry["sentence"].replace("_______", entry["word"])
        trans = translate(original)
        entry["translation"] = trans
        done += 1
        print(f"[{done}/{len(data)}] {entry['word']}: {trans[:60] if trans else 'FAIL'}", flush=True)
        # Save incrementally
        with open(OUTPUT, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # Polite delay
        time.sleep(random.uniform(0.8, 1.5))

    # Re-export TSV
    with open(TSV_OUTPUT, "w", encoding="utf-8") as f:
        for r in data:
            f.write(f"{r['word']}\t{r['def']}\t{r['sentence']}\t{r['translation']}\n")

    with_trans = sum(1 for r in data if r["translation"])
    print(f"\nDone: {len(data)} words, {with_trans} with translations")


if __name__ == "__main__":
    main()
