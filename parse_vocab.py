#!/usr/bin/env python3
"""SAT/GRE 词汇 PDF 解析器
用法: python parse_vocab.py 输入.pdf|输入.txt [输出.json]
输出 JSON: [{ "word": "...", "def": "词性 释义", "pos": "n.;v." }, ...]
"""
import re
import sys
import json
from pathlib import Path


def read_input(path: str) -> str:
    """支持读取 PDF 或 txt。PDF 会自动检测双栏排版并按列提取。"""
    p = Path(path)
    if p.suffix.lower() == ".pdf":
        return extract_pdf_columns(p)
    return p.read_text(encoding="utf-8")


def extract_pdf_columns(p: Path) -> str:
    """提取 PDF 文本，自动处理双栏排版：左栏全部内容在前，右栏在后。"""
    import pdfplumber
    texts = []
    with pdfplumber.open(p) as pdf:
        for page in pdf.pages:
            words = page.extract_words(use_text_flow=True)
            if not words:
                continue
            # 计算页面宽度和列分割点（双栏通常在页面中间附近）
            max_x = max(w["x1"] for w in words)
            col_split = max_x / 2
            # 检查是否真的有两栏：左右两侧都有词条编号（数字开头的单词）
            left_has_num = any(
                w["text"].isdigit() and w["x0"] < col_split for w in words
            )
            right_has_num = any(
                w["text"].isdigit() and w["x0"] >= col_split for w in words
            )
            two_col = left_has_num and right_has_num

            # 按 y 坐标分组为行（y 坐标接近的合并）
            lines = {}
            for w in words:
                y = round(w["top"])
                key = None
                for k in lines:
                    if abs(k - y) <= 3:
                        key = k
                        break
                if key is None:
                    key = y
                lines.setdefault(key, []).append(w)

            def join_with_spaces(ws):
                """按 x 坐标间距拼接单词，间距大则加空格。"""
                if not ws:
                    return ""
                parts = [ws[0]["text"]]
                for i in range(1, len(ws)):
                    gap = ws[i]["x0"] - ws[i - 1]["x1"]
                    parts.append(" " if gap > 1 else "")
                    parts.append(ws[i]["text"])
                return "".join(parts)

            sorted_y = sorted(lines.keys())
            left_lines, right_lines = [], []
            for y in sorted_y:
                items = sorted(lines[y], key=lambda w: w["x0"])
                if two_col:
                    left = [w for w in items if w["x0"] < col_split]
                    right = [w for w in items if w["x0"] >= col_split]
                    if left:
                        left_lines.append(join_with_spaces(left))
                    if right:
                        right_lines.append(join_with_spaces(right))
                else:
                    left_lines.append(join_with_spaces(items))

            page_text = "\n".join(left_lines)
            if right_lines:
                page_text += "\n" + "\n".join(right_lines)
            texts.append(page_text)
    return "\n".join(texts)


POS = r"(?:vt|vi|adj|adv|prep|conj|pron|interj|int|aux|abbr|n|v)"
POS_RE = re.compile(r"(?<![A-Za-z])(" + POS + r"\.?)(?![A-Za-z])")
# 词条开头：编号 + 英文单词（编号和单词之间可以没有空格，如 "1allegiance"）
ENTRY_RE = re.compile(r"(?<!\S)(\d{1,3})\s*([A-Za-z][A-Za-z\-\']*)")
BRACKET_RE = re.compile(r"\[[^\]]*\]")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def clean_meaning(s: str) -> str:
    s = BRACKET_RE.sub(" ", s)
    s = POS_RE.sub(" ", s)
    s = re.sub(r"[A-Za-z]+", " ", s)
    # 去掉页码标记，如 -14-
    s = re.sub(r"-\d+-", " ", s)
    # 去掉中文字符之间的多余空格（保留标点前后的空格）
    s = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip(" \t;；,，。.-")


def parse_entries(text: str):
    text = text.replace("\u00a0", " ")
    # 修复编号与单词分行的情况：如果某行只有编号，把它移到上一行单词前面
    lines = text.split("\n")
    fixed = []
    for line in lines:
        stripped = line.strip()
        if re.fullmatch(r"\d{1,3}", stripped) and fixed:
            # 这行只有编号，插到上一行开头
            fixed[-1] = stripped + " " + fixed[-1]
        else:
            fixed.append(line)
    text = "\n".join(fixed)
    matches = list(ENTRY_RE.finditer(text))
    rows = []

    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[start:end]

        word = m.group(2)
        rest = block[m.end() - start:]
        rest = re.sub(r"\s+", " ", rest).strip()

        # 先去掉音标方括号（IPA 中的 n/v 等会被误识别为词性）
        rest_no_ipa = BRACKET_RE.sub(" ", rest)

        pos_matches = list(POS_RE.finditer(rest_no_ipa))

        if pos_matches:
            first_pos = pos_matches[0].start()
            before_pos = rest_no_ipa[:first_pos]
            frag = re.findall(r"[A-Za-z][A-Za-z\-\']*", before_pos)
            if frag:
                word += "".join(frag)
            meaning_part = rest_no_ipa[first_pos:]
        else:
            meaning_part = rest_no_ipa

        pos_list = []
        for pm in POS_RE.finditer(meaning_part):
            p = pm.group(1)
            if p not in pos_list:
                pos_list.append(p)

        meaning = clean_meaning(meaning_part)
        if not CJK_RE.search(meaning):
            continue

        pos = "; ".join(pos_list)
        rows.append({
            "word": word,
            "def": (pos + " " + meaning).strip() if pos else meaning,
            "pos": pos,
            "meaning": meaning,
            "sentence": "",
            "translation": "",
            "src": ""
        })

    return rows


def main():
    # Mode 1: --stdin  (read text from stdin, output JSON items to stdout)
    # Mode 2: --full <input>  (output { items, rawText } JSON to stdout)
    # Mode 3: <input> [output]  (read PDF/txt file, write items JSON to file or stdout)
    if len(sys.argv) >= 2 and sys.argv[1] == "--stdin":
        text = sys.stdin.read()
        rows = parse_entries(text)
        json.dump(rows, sys.stdout, ensure_ascii=False)
        return

    if len(sys.argv) >= 3 and sys.argv[1] == "--full":
        inp = sys.argv[2]
        text = read_input(inp)
        rows = parse_entries(text)
        json.dump({"items": rows, "rawText": text}, sys.stdout, ensure_ascii=False)
        return

    if len(sys.argv) < 2:
        print("用法: python parse_vocab.py 输入.pdf|输入.txt [输出.json]")
        print("      python parse_vocab.py --stdin   (从 stdin 读文本，stdout 输出 JSON)")
        print("      python parse_vocab.py --full <input>  (输出 { items, rawText } JSON)")
        sys.exit(1)

    inp = sys.argv[1]
    outp = sys.argv[2] if len(sys.argv) > 2 else None

    text = read_input(inp)
    rows = parse_entries(text)

    if outp:
        with open(outp, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)
        print(f"已生成: {outp}，共 {len(rows)} 条")
    else:
        json.dump(rows, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
