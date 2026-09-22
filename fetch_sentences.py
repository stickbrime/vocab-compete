#!/usr/bin/env python3
"""Fetch real example sentences from thesaurus.com for a list of vocabulary words.

Output: sentences_100.json with word, def, sentence (blanked), translation (if available), src.
Also prints a TSV preview to stdout.
"""
import json
import re
import sys
import time
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

WORDS_FILE = "words_100.json"
OUTPUT_FILE = "sentences_100.json"
TSV_FILE = "vocab_100_with_sentences.tsv"

session = requests.Session()
session.headers.update(HEADERS)


def fetch_sentences(word):
    """Fetch example sentences for a word from thesaurus.com. Returns list of (sentence, source)."""
    url = f"https://www.thesaurus.com/browse/{word}"
    try:
        r = session.get(url, timeout=20)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, "html.parser")
        ex_section = soup.find(id="examples")
        if not ex_section:
            return []
        results = []
        for bq in ex_section.find_all("blockquote", class_="box-examples"):
            sent_p = bq.find("p", class_="txt-example")
            src_p = bq.find("p", class_="txt-source")
            if not sent_p:
                continue
            # Get sentence text, preserving the word position
            sentence = sent_p.get_text(" ", strip=True)
            # Collapse extra spaces
            sentence = re.sub(r"\s+", " ", sentence).strip()
            source = ""
            if src_p:
                source = src_p.get_text(" ", strip=True)
                source = re.sub(r"\s+", " ", source).strip()
            results.append((sentence, source))
        return results
    except Exception as e:
        return []


def blank_word(sentence, word):
    """Replace the target word (and common inflections) in the sentence with _______."""
    # Try exact word first, then common inflections
    patterns = [
        re.compile(rf"\b{re.escape(word)}\w*\b", re.IGNORECASE),
    ]
    # Add a few common inflection patterns
    base = word
    for suffix in ["s", "es", "ed", "ing", "d", "er", "est", "ly", "tion", "ions"]:
        patterns.append(re.compile(rf"\b{re.escape(base)}{re.escape(suffix)}\b", re.IGNORECASE))
    for p in patterns:
        if p.search(sentence):
            return p.sub("_______", sentence, count=1)
    return sentence


def translate_text(text):
    """Try to translate English text to Chinese using the unofficial Google Translate endpoint."""
    try:
        url = "https://translate.googleapis.com/translate_a/single"
        params = {
            "client": "gtx",
            "sl": "en",
            "tl": "zh-CN",
            "dt": "t",
            "q": text,
        }
        r = session.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return ""
        data = r.json()
        # data[0] is a list of [translated, original, ...] tuples
        parts = []
        for item in data[0]:
            if item[0]:
                parts.append(item[0])
        return "".join(parts)
    except Exception:
        return ""


def process_word(entry):
    word = entry["word"]
    d = entry["def"]
    sentences = fetch_sentences(word)
    # Pick the first sentence that, when blanked, actually changed (i.e. contained the word)
    chosen_sentence = ""
    chosen_source = ""
    for sent, src in sentences:
        blanked = blank_word(sent, word)
        if blanked != sent and "_______" in blanked:
            chosen_sentence = blanked
            chosen_source = src
            break
    # Fallback: use first sentence even if blank didn't apply
    if not chosen_sentence and sentences:
        chosen_sentence = sentences[0][0]
        chosen_source = sentences[0][1]
    # Translate the original (non-blanked) sentence
    translation = ""
    if chosen_sentence:
        original = chosen_sentence.replace("_______", word)
        translation = translate_text(original)
    # Small delay to be polite
    time.sleep(random.uniform(0.2, 0.5))
    return {
        "word": word,
        "def": d,
        "sentence": chosen_sentence,
        "translation": translation,
        "src": chosen_source,
    }


def main():
    with open(WORDS_FILE, encoding="utf-8") as f:
        words = json.load(f)
    print(f"Loaded {len(words)} words", file=sys.stderr)

    results = []
    # Use a thread pool for concurrency, but keep it modest (4 workers) to avoid rate limiting
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(process_word, entry): entry for entry in words}
        done = 0
        for fut in as_completed(futures):
            entry = futures[fut]
            try:
                res = fut.result()
                results.append(res)
                done += 1
                status = "OK" if res["sentence"] else "NO SENTENCE"
                print(f"[{done}/{len(words)}] {res['word']}: {status} src={res['src'][:40]}", file=sys.stderr)
            except Exception as e:
                done += 1
                print(f"[{done}/{len(words)}] {entry['word']}: ERROR {e}", file=sys.stderr)
                results.append({
                    "word": entry["word"], "def": entry["def"],
                    "sentence": "", "translation": "", "src": "",
                })

    # Restore original order
    order = {w["word"]: i for i, w in enumerate(words)}
    results.sort(key=lambda r: order.get(r["word"], 9999))

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    # TSV output: word \t def \t sentence \t translation
    with open(TSV_FILE, "w", encoding="utf-8") as f:
        for r in results:
            f.write(f"{r['word']}\t{r['def']}\t{r['sentence']}\t{r['translation']}\n")

    with_sent = sum(1 for r in results if r["sentence"])
    with_trans = sum(1 for r in results if r["translation"])
    print(f"\nDone: {len(results)} words, {with_sent} with sentences, {with_trans} with translations", file=sys.stderr)
    print(f"Output: {OUTPUT_FILE}, {TSV_FILE}", file=sys.stderr)


if __name__ == "__main__":
    main()
