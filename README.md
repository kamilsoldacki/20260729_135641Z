# TAIL — Anzellan Voice Lab

Local one-pager for auditioning TAIL character voices (Vilo / Kado / Jibu / Accent) on ElevenLabs **`eleven_v3`** and **`eleven_v4`**, with the Anzellan pronunciation dictionary attached per [ElevenLabs docs](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries).

## Quick start

```bash
cd "/Users/kamilsoldacki/Python/# GitHub/20260729_135641Z"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set ELEVENLABS_API_KEY
python app.py
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

## Voices

Edit `config/voices.json` — `characters[].voices` is empty on purpose (you said you’ll provide IDs later). Example entry:

```json
{
  "id": "Wlz1LudTO79ktz1mWg4X",
  "label": "Vilo rasp close",
  "tier": "close",
  "pack": "rasp_brief"
}
```

Reload the page after saving. No server restart needed for voice list changes.

## Pronunciation dictionary

| Model | Mode | Source |
|-------|------|--------|
| `eleven_v3` | IPA phoneme PLS | `data/anzellan_pronunciation_EXACT_DOCX.pls` → dict `kGhqjTsEsWf2rfzEQ81a` / version `rbVmbjPXniy9ZFAqRwV1` (same as RASP BRIEF / DOCX faithful packs) |
| `eleven_v4` | Alias PLS | `data/anzellan_pronunciation_ALIAS_v4.pls` — auto-uploaded on first v4 generate if no ID is set (phoneme tags are skipped on non-v3/flash models per docs) |

Every TTS request sends `pronunciation_dictionary_locators` unless you uncheck **Pronunciation dictionary** in the UI (A/B compare).

## Scripts

Defaults include the four bilingual DOCX lines and character-tagged v3 prompts (`[impatient]`, `[excited]`, …). Chip buttons append DOCX lines into the editor.
