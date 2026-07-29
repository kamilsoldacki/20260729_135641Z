# TAIL — Anzellan Voice Lab

One-pager for auditioning TAIL character voices (Vilo / Kado / Jibu / Accent) on ElevenLabs **`eleven_v3`** and **`eleven_v4`**, with the Anzellan pronunciation dictionary attached per [ElevenLabs docs](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries).

## GitHub Pages (canonical)

Live site: [https://kamilsoldacki.github.io/20260729_135641Z/](https://kamilsoldacki.github.io/20260729_135641Z/)

Same pattern as [elevenlabs-tts-page](https://github.com/kamilsoldacki/elevenlabs-tts-page): static `docs/` + Actions injects the API key at deploy time.

### One-time setup

1. Repo → **Settings → Secrets and variables → Actions** → New repository secret  
   - Name: `ELEVENLABS_API_KEY`  
   - Value: your ElevenLabs key
2. **Settings → Pages** → **Source**: GitHub Actions
3. Push to `main` (or run **Actions → Deploy Pages → Run workflow**)

The workflow replaces `__INJECT_KEY__` in `docs/app.js` and sets `__BASE__` to `/20260729_135641Z`. The published JS contains the key (visible in DevTools) — same trade-off as the earlier TTS Pages projects; the key is never committed to git.

### Voices on Pages

Edit [`docs/config.json`](docs/config.json) (keep [`config/voices.json`](config/voices.json) in sync if you also use local FastAPI). Example entry under `characters[].voices`:

```json
{
  "id": "Wlz1LudTO79ktz1mWg4X",
  "label": "Vilo rasp close",
  "tier": "close",
  "pack": "rasp_brief"
}
```

## Local FastAPI (optional)

```bash
cd "/Users/kamilsoldacki/Python/# GitHub/20260729_135641Z"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set ELEVENLABS_API_KEY
python app.py
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

## Pronunciation dictionary

| Model | Mode | Source |
|-------|------|--------|
| `eleven_v3` | IPA phoneme PLS | `docs/data/anzellan_pronunciation_EXACT_DOCX.pls` → dict `kGhqjTsEsWf2rfzEQ81a` / version `rbVmbjPXniy9ZFAqRwV1` |
| `eleven_v4` | Alias PLS | `docs/data/anzellan_pronunciation_ALIAS_v4.pls` — auto-uploaded on first v4 generate if no ID is set (cached in `localStorage` on Pages) |

Every TTS request sends `pronunciation_dictionary_locators` unless you uncheck **Pronunciation dictionary** in the UI (A/B compare).

## Scripts

Defaults include the four bilingual DOCX lines and character-tagged v3 prompts (`[impatient]`, `[excited]`, …). Chip buttons append DOCX lines into the editor.
