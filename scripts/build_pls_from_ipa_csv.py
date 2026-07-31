#!/usr/bin/env python3
"""Build Anzellan + English phoneme PLS files from TAIL_*_IPA.csv."""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "data" / "TAIL_ALL_20260730_IPA.csv"

ANZELLAN_OUT = ROOT / "data" / "anzellan_pronunciation_EXACT_DOCX.pls"
ANZELLAN_DOCS = ROOT / "docs" / "data" / "anzellan_pronunciation_EXACT_DOCX.pls"
ENGLISH_OUT = ROOT / "data" / "english_pronunciation_IPA.pls"
ENGLISH_DOCS = ROOT / "docs" / "data" / "english_pronunciation_IPA.pls"

# DOCX-exact overrides: never let CSV variants (e.g. nie̯) replace these.
DOCX_OVERRIDES: dict[str, str] = {
    "nie": "ni̯e",
    "hei": "hei̯",
    "djoid": "dʒoi̯d",
    "sheena": "ʃeena",
    "pobem": "pobem",
    "degaemi": "deɡaemi",
    "tumunie": "tumuni̯e",
    "pilage": "pilaɡe",
    "aba": "aba",
    "abba": "abba",
    "pena": "pena",
    "ipa": "ipa",
    "matumu": "matumu",
    "tumu": "tumu",
    "mama": "mama",
    "babumaba": "babumaba",
    "moga": "moɡa",
    "nad": "nad",
    "kado": "kado",
    "problem": "pobem",
}

# Letters with optional internal hyphens/apostrophes (not leading/trailing).
GRAPHEME_RE = re.compile(r"^[A-Za-z]+(?:['-][A-Za-z]+)*$")
PUNCT_EDGE = re.compile(r"^[!?.,;:\"'…\u2026\[\(]+|[!?.,;:\"'…\u2026\]\)]+$")


def xml_escape(text: str) -> str:
    return escape(text, {"'": "&apos;", '"': "&quot;"})


def clean_token(token: str) -> str:
    return PUNCT_EDGE.sub("", token.strip())


def clean_ipa(ipa: str) -> str:
    cleaned = clean_token(ipa)
    cleaned = cleaned.strip("[]'\"")
    if cleaned.endswith("-") and cleaned.count("-") == 1 and len(cleaned) <= 3:
        cleaned = cleaned.rstrip("-")
    return cleaned


def split_words(text: str) -> list[str]:
    rough = re.split(r"[\s!?.,;:]+", text.strip())
    return [w for w in (clean_token(t) for t in rough) if w]


def split_ipa(text: str) -> list[str]:
    return [p for p in (clean_ipa(t) for t in text.split()) if p]


def title_case(word: str) -> str:
    if not word:
        return word
    return word[0].upper() + word[1:]


def resolve_under_root(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise SystemExit(f"Refusing path outside repo root: {resolved}") from exc
    return resolved


def collect_word_ipa(
    csv_path: Path, text_col: str, ipa_col: str
) -> dict[str, Counter[str]]:
    word_ipa: dict[str, Counter[str]] = defaultdict(Counter)
    aligned = 0
    skipped = 0

    with csv_path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        required = {text_col, ipa_col}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise SystemExit(
                f"CSV missing {text_col}/{ipa_col} columns: {reader.fieldnames}"
            )
        for row in reader:
            text = (row.get(text_col) or "").strip()
            ipa = (row.get(ipa_col) or "").strip()
            if not text or not ipa:
                skipped += 1
                continue
            words = split_words(text)
            phones = split_ipa(ipa)
            if len(words) != len(phones):
                skipped += 1
                continue
            aligned += 1
            for word, phone in zip(words, phones):
                if not GRAPHEME_RE.match(word):
                    continue
                if not phone:
                    continue
                word_ipa[word.lower()][phone] += 1

    print(
        f"{text_col}: aligned={aligned} skipped={skipped} unique_words={len(word_ipa)}"
    )
    return word_ipa


def pick_ipa(
    word: str, counts: Counter[str], overrides: dict[str, str] | None
) -> str:
    if overrides and word in overrides:
        return overrides[word]
    return counts.most_common(1)[0][0]


def build_lexemes(
    word_ipa: dict[str, Counter[str]],
    overrides: dict[str, str] | None = None,
) -> list[tuple[str, str]]:
    merged = dict(word_ipa)
    if overrides:
        for key, value in overrides.items():
            merged.setdefault(key, Counter({value: 1}))

    lexemes: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for word in sorted(merged.keys(), key=lambda w: (w.lower(), w)):
        ipa = pick_ipa(word, merged[word], overrides)
        for grapheme in (word, title_case(word)):
            key = (grapheme, ipa)
            if key in seen:
                continue
            seen.add(key)
            lexemes.append((grapheme, ipa))

    return lexemes


def write_pls(path: Path, lexemes: list[tuple[str, str]], header_comments: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<lexicon version="1.0"',
        '  xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"',
        '  alphabet="ipa" xml:lang="en">',
    ]
    for comment in header_comments:
        lines.append(f"  <!-- {comment} -->")
    for grapheme, phoneme in lexemes:
        lines.append("  <lexeme>")
        lines.append(f"    <grapheme>{xml_escape(grapheme)}</grapheme>")
        lines.append(f"    <phoneme>{xml_escape(phoneme)}</phoneme>")
        lines.append("  </lexeme>")
    lines.append("</lexicon>")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {path} ({len(lexemes)} lexemes)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        type=Path,
        default=DEFAULT_CSV,
        help=f"IPA CSV path (default: {DEFAULT_CSV})",
    )
    parser.add_argument(
        "--also-docs",
        action="store_true",
        help="Also write PLS copies under docs/data/",
    )
    args = parser.parse_args(argv)

    csv_path = resolve_under_root(args.csv)
    if not csv_path.is_file():
        raise SystemExit(f"CSV not found: {csv_path}")

    anzellan = collect_word_ipa(csv_path, "Anzellan", "Anzellan_IPA")
    anzellan_lexemes = build_lexemes(anzellan, DOCX_OVERRIDES)
    write_pls(
        resolve_under_root(ANZELLAN_OUT),
        anzellan_lexemes,
        [
            "Built from TAIL_*_IPA.csv (Anzellan word ↔ Anzellan_IPA).",
            "DOCX-exact overrides kept for nie/hei/djoid/tumunie/….",
            "Orthography: x→ʃ, dj→dʒ, g→ɡ; ie→i̯e, ei→ei̯, oi→oi̯; problem→pobem.",
        ],
    )

    english = collect_word_ipa(csv_path, "English", "English_IPA")
    english_lexemes = build_lexemes(english, overrides=None)
    write_pls(
        resolve_under_root(ENGLISH_OUT),
        english_lexemes,
        [
            "Built from TAIL_*_IPA.csv (English word ↔ English_IPA).",
            "Character-accent English IPA for optional inline rewrite.",
        ],
    )

    if args.also_docs:
        write_pls(
            resolve_under_root(ANZELLAN_DOCS),
            anzellan_lexemes,
            [
                "Built from TAIL_*_IPA.csv (Anzellan word ↔ Anzellan_IPA).",
                "DOCX-exact overrides kept for nie/hei/djoid/tumunie/….",
                "Orthography: x→ʃ, dj→dʒ, g→ɡ; ie→i̯e, ei→ei̯, oi→oi̯; problem→pobem.",
            ],
        )
        write_pls(
            resolve_under_root(ENGLISH_DOCS),
            english_lexemes,
            [
                "Built from TAIL_*_IPA.csv (English word ↔ English_IPA).",
                "Character-accent English IPA for optional inline rewrite.",
            ],
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
