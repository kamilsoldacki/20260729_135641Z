#!/usr/bin/env python3
"""Sync local Anzellan/English PLS files to ElevenLabs pronunciation dictionaries.

Per ElevenLabs docs:
- phoneme PLS works on eleven_v3
- update via set-rules (replace all) or create via add-from-file
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

import httpx

ROOT = Path(__file__).resolve().parents[1]
VOICES = ROOT / "config" / "voices.json"
DOCS_CONFIG = ROOT / "docs" / "config.json"
API_BASE = "https://api.elevenlabs.io"
NS = {"pls": "http://www.w3.org/2005/01/pronunciation-lexicon"}


def resolve_under_root(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise SystemExit(f"Refusing path outside repo root: {resolved}") from exc
    return resolved


def api_key() -> str:
    key = (
        os.environ.get("ELEVENLABS_API_KEY")
        or os.environ.get("ELEVEN_API_KEY")
        or os.environ.get("XI_API_KEY")
        or ""
    ).strip()
    if not key:
        raise SystemExit("Missing ELEVENLABS_API_KEY in environment.")
    return key


def load_json(path: Path) -> dict:
    with resolve_under_root(path).open(encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path: Path, data: dict) -> None:
    path = resolve_under_root(path)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def pls_to_phoneme_rules(pls_path: Path) -> list[dict]:
    root = ET.parse(resolve_under_root(pls_path)).getroot()
    rules: list[dict] = []
    seen: set[str] = set()
    for lex in root.findall("pls:lexeme", NS):
        grapheme = (lex.findtext("pls:grapheme", default="", namespaces=NS) or "").strip()
        phoneme = (lex.findtext("pls:phoneme", default="", namespaces=NS) or "").strip()
        if not grapheme or not phoneme:
            continue
        if grapheme in seen:
            continue
        seen.add(grapheme)
        rules.append(
            {
                "type": "phoneme",
                "string_to_replace": grapheme,
                "phoneme": phoneme,
                "alphabet": "ipa",
            }
        )
    return rules


def set_rules(client: httpx.Client, key: str, dictionary_id: str, rules: list[dict]) -> dict:
    resp = client.post(
        f"{API_BASE}/v1/pronunciation-dictionaries/{dictionary_id}/set-rules",
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        json={"rules": rules},
    )
    if resp.status_code >= 400:
        raise SystemExit(
            f"set-rules failed for {dictionary_id}: HTTP {resp.status_code}: {resp.text[:800]}"
        )
    return resp.json()


def create_from_file(client: httpx.Client, key: str, pls_path: Path, name: str, description: str) -> dict:
    pls_path = resolve_under_root(pls_path)
    files = {"file": (pls_path.name, pls_path.read_bytes(), "application/pls+xml")}
    data = {"name": name, "description": description}
    resp = client.post(
        f"{API_BASE}/v1/pronunciation-dictionaries/add-from-file",
        headers={"xi-api-key": key},
        files=files,
        data=data,
    )
    if resp.status_code >= 400:
        raise SystemExit(
            f"add-from-file failed for {name}: HTTP {resp.status_code}: {resp.text[:800]}"
        )
    return resp.json()


def sync_block(
    client: httpx.Client,
    key: str,
    block: dict,
    *,
    create_name: str,
    create_description: str,
) -> dict:
    pls_file = block.get("pls_file")
    if not pls_file:
        raise SystemExit("Missing pls_file in pronunciation block")
    pls_path = ROOT / "data" / Path(pls_file).name
    if not pls_path.is_file():
        raise SystemExit(f"Missing PLS: {pls_path}")

    rules = pls_to_phoneme_rules(pls_path)
    print(f"{create_name}: local_rules={len(rules)}")

    dict_id = block.get("dictionary_id")
    if dict_id:
        body = set_rules(client, key, dict_id, rules)
        entry = {
            "dictionary_id": body.get("id") or dict_id,
            "version_id": body["version_id"],
            "version_rules_num": body.get("version_rules_num"),
        }
        print(
            f"{create_name}: updated dict={entry['dictionary_id']} "
            f"version={entry['version_id']} rules={entry.get('version_rules_num')}"
        )
        return entry

    created = create_from_file(client, key, pls_path, create_name, create_description)
    entry = {
        "dictionary_id": created["id"],
        "version_id": created.get("version_id"),
        "version_rules_num": created.get("version_rules_num"),
    }
    print(
        f"{create_name}: created dict={entry['dictionary_id']} "
        f"version={entry['version_id']} rules={entry.get('version_rules_num')}"
    )
    return entry


def apply_ids(cfg: dict, key: str, entry: dict) -> None:
    block = cfg.setdefault("pronunciation", {}).setdefault(key, {})
    block["dictionary_id"] = entry["dictionary_id"]
    block["version_id"] = entry.get("version_id")
    if entry.get("version_rules_num") is not None:
        block["version_rules_num"] = entry["version_rules_num"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--also-docs",
        action="store_true",
        help="Also update docs/config.json",
    )
    parser.add_argument(
        "--skip-english",
        action="store_true",
        help="Only sync Anzellan phoneme dictionary",
    )
    args = parser.parse_args(argv)

    key = api_key()
    voices = load_json(VOICES)
    pronunciation = voices.get("pronunciation") or {}
    phoneme = pronunciation.get("phoneme") or {}
    english = pronunciation.get("english") or {}

    with httpx.Client(timeout=180.0, trust_env=False) as client:
        anzellan_entry = sync_block(
            client,
            key,
            phoneme,
            create_name="TAIL_Anzellan_IPA",
            create_description="Anzellan IPA phoneme lexicon from TAIL_ALL IPA CSV + DOCX overrides",
        )
        apply_ids(voices, "phoneme", anzellan_entry)

        if not args.skip_english:
            if "pls_file" not in english:
                english["pls_file"] = "english_pronunciation_IPA.pls"
                pronunciation["english"] = english
                voices["pronunciation"] = pronunciation
            english_entry = sync_block(
                client,
                key,
                english,
                create_name="TAIL_English_IPA",
                create_description="Character-accent English IPA from TAIL_ALL English_IPA CSV",
            )
            apply_ids(voices, "english", english_entry)

    save_json(VOICES, voices)
    print(f"updated {VOICES}")

    if args.also_docs:
        docs = load_json(DOCS_CONFIG)
        docs_pron = docs.setdefault("pronunciation", {})
        for key_name in ("phoneme", "english"):
            src = voices["pronunciation"].get(key_name) or {}
            dst = docs_pron.setdefault(key_name, {})
            for field in ("pls_file", "name", "dictionary_id", "version_id", "version_rules_num"):
                if field in src and src[field] is not None:
                    dst[field] = src[field]
        save_json(DOCS_CONFIG, docs)
        print(f"updated {DOCS_CONFIG}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
