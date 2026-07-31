"""TAIL Anzellan Voice Lab — local TTS one-pager for ElevenLabs v3 / v4."""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

CONFIG_PATH = ROOT / "config" / "voices.json"
DICT_CACHE_PATH = ROOT / "config" / "dictionary_cache.json"
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
API_BASE = "https://api.elevenlabs.io"
ALLOWED_MODELS = frozenset({"eleven_v3", "eleven_v4"})
VOICE_ID_RE = re.compile(r"^[A-Za-z0-9]{10,64}$")

_config_lock = threading.Lock()
_alias_ensure_lock = threading.Lock()

app = FastAPI(title="TAIL Anzellan Voice Lab", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8787",
        "http://localhost:8787",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def api_key() -> str:
    key = (
        os.environ.get("ELEVENLABS_API_KEY")
        or os.environ.get("ELEVEN_API_KEY")
        or os.environ.get("XI_API_KEY")
        or ""
    ).strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="Missing ELEVENLABS_API_KEY (set in .env or environment).",
        )
    return key


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def load_dict_cache() -> dict[str, Any]:
    if not DICT_CACHE_PATH.exists():
        return {}
    with DICT_CACHE_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_dict_cache(cache: dict[str, Any]) -> None:
    DICT_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DICT_CACHE_PATH.open("w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2)
        f.write("\n")


def model_pls_supported(cfg: dict[str, Any], model_id: str) -> bool:
    models = {m["id"]: m for m in cfg.get("models", [])}
    meta = models.get(model_id, {})
    if "pls_supported" in meta:
        return bool(meta["pls_supported"])
    return model_id == "eleven_v3"


def resolve_dict_locator(cfg: dict[str, Any], model_id: str) -> dict[str, str]:
    """Pick phoneme dictionary locator for models that support PLS."""
    if not model_pls_supported(cfg, model_id):
        raise HTTPException(
            status_code=400,
            detail="PLS dictionaries are not available for this model yet.",
        )

    models = {m["id"]: m for m in cfg.get("models", [])}
    mode = models.get(model_id, {}).get("dict_mode")
    if mode not in ("phoneme", "alias"):
        mode = "phoneme"

    return locator_for_block(cfg, mode)


def locator_for_block(cfg: dict[str, Any], mode: str) -> dict[str, str]:
    block = cfg.get("pronunciation", {}).get(mode) or {}
    dict_id = block.get("dictionary_id")
    version_id = block.get("version_id")

    cache = load_dict_cache()
    cached = cache.get(mode) or {}
    if not dict_id:
        dict_id = cached.get("dictionary_id")
    if not version_id:
        version_id = cached.get("version_id")

    if not dict_id:
        if mode == "alias" and block.get("auto_create"):
            created = ensure_alias_dictionary(cfg)
            dict_id = created["dictionary_id"]
            version_id = created.get("version_id")
        else:
            raise HTTPException(
                status_code=400,
                detail=f"No pronunciation dictionary configured for mode={mode}.",
            )

    locator: dict[str, str] = {"pronunciation_dictionary_id": dict_id}
    if version_id:
        locator["version_id"] = version_id
    return locator


def resolve_tts_locators(
    cfg: dict[str, Any],
    model_id: str,
    *,
    use_anzellan: bool,
    use_english: bool,
) -> list[dict[str, str]]:
    """Build ordered PLS locators for v3 (Anzellan first, then English)."""
    if not model_pls_supported(cfg, model_id):
        return []

    locators: list[dict[str, str]] = []
    if use_anzellan:
        locators.append(resolve_dict_locator(cfg, model_id))
    if use_english:
        english = cfg.get("pronunciation", {}).get("english") or {}
        if english.get("dictionary_id"):
            locators.append(locator_for_block(cfg, "english"))
    return locators


def ensure_alias_dictionary(cfg: dict[str, Any]) -> dict[str, str]:
    """Upload alias PLS once and cache locators locally."""
    with _alias_ensure_lock:
        cache = load_dict_cache()
        if cache.get("alias", {}).get("dictionary_id"):
            return cache["alias"]

        block = cfg["pronunciation"]["alias"]
        pls_path = DATA_DIR / block["pls_file"]
        if not pls_path.is_file():
            raise HTTPException(status_code=500, detail=f"Missing PLS file: {pls_path.name}")

        key = api_key()
        name = f"Anzellan_ALIAS_v4_{pls_path.stem}"
        # trust_env=False: ignore broken HTTP(S)_PROXY from IDE sandboxes
        with httpx.Client(timeout=60.0, trust_env=False) as client:
            files = {"file": (pls_path.name, pls_path.read_bytes(), "application/pls+xml")}
            data = {
                "name": name,
                "description": "Anzellan alias lexicon for models that skip phoneme tags (TAIL DOCX).",
            }
            resp = client.post(
                f"{API_BASE}/v1/pronunciation-dictionaries/add-from-file",
                headers={"xi-api-key": key},
                files=files,
                data=data,
            )
            if resp.status_code >= 400:
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to create alias dictionary: {resp.text}",
                )
            body = resp.json()

        entry = {
            "dictionary_id": body["id"],
            "version_id": body.get("version_id"),
            "name": body.get("name", name),
        }
        cache["alias"] = entry
        save_dict_cache(cache)

        # Persist into voices.json when possible so restarts stay offline-friendly
        with _config_lock:
            live = load_config()
            live["pronunciation"]["alias"]["dictionary_id"] = entry["dictionary_id"]
            live["pronunciation"]["alias"]["version_id"] = entry.get("version_id")
            with CONFIG_PATH.open("w", encoding="utf-8") as f:
                json.dump(live, f, indent=2, ensure_ascii=False)
                f.write("\n")

        return entry


class TtsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice_id: str
    model_id: Literal["eleven_v3", "eleven_v4"] = "eleven_v3"
    seed: int | None = Field(default=None, ge=0, le=4_294_967_295)
    use_dictionary: bool = True
    use_english_dictionary: bool = False
    stability: float | None = Field(default=None, ge=0.0, le=1.0)
    similarity_boost: float | None = Field(default=None, ge=0.0, le=1.0)
    style: float | None = Field(default=None, ge=0.0, le=1.0)

    @field_validator("voice_id")
    @classmethod
    def validate_voice_id(cls, v: str) -> str:
        v = v.strip()
        if not VOICE_ID_RE.match(v):
            raise ValueError("Invalid voice_id format.")
        return v

    @field_validator("text")
    @classmethod
    def strip_text(cls, v: str) -> str:
        text = v.strip()
        if not text:
            raise ValueError("Text cannot be empty.")
        return text


@app.get("/api/health")
def health() -> dict[str, Any]:
    has_key = bool(
        (
            os.environ.get("ELEVENLABS_API_KEY")
            or os.environ.get("ELEVEN_API_KEY")
            or os.environ.get("XI_API_KEY")
            or ""
        ).strip()
    )
    return {"ok": True, "api_key_configured": has_key}


@app.get("/api/config")
def get_config() -> dict[str, Any]:
    cfg = load_config()
    cache = load_dict_cache()
    # Merge cached alias locators for UI display without mutating file on read
    alias = dict(cfg["pronunciation"]["alias"])
    if not alias.get("dictionary_id") and cache.get("alias"):
        alias.update(cache["alias"])
    # Prefer voices[]; fall back to legacy characters[] key
    voices = cfg.get("voices") or cfg.get("characters") or []
    return {
        "brand": cfg.get("brand", "TAIL"),
        "title": cfg.get("title", "Anzellan Voice Lab"),
        "models": cfg.get("models", []),
        "voices": voices,
        "sample_scripts": cfg.get("sample_scripts", {}),
        "orthography": cfg.get("orthography", []),
        "pronunciation": {
            "phoneme": cfg["pronunciation"]["phoneme"],
            "alias": alias,
            "english": cfg["pronunciation"].get("english")
            or {"name": "English IPA", "pls_file": "english_pronunciation_IPA.pls"},
        },
        "api_key_configured": bool(
            (
                os.environ.get("ELEVENLABS_API_KEY")
                or os.environ.get("ELEVEN_API_KEY")
                or os.environ.get("XI_API_KEY")
                or ""
            ).strip()
        ),
    }


@app.post("/api/tts")
def tts(req: TtsRequest) -> Response:
    if req.model_id not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail="Model not allowed.")

    cfg = load_config()
    key = api_key()

    payload: dict[str, Any] = {
        "text": req.text,
        "model_id": req.model_id,
    }
    # v4 IPA: inline /IPA/ requires the text normalizer off (no PLS locators).
    if req.model_id == "eleven_v4":
        payload["apply_text_normalization"] = "off"
    if req.seed is not None:
        payload["seed"] = req.seed

    voice_settings: dict[str, float] = {}
    if req.stability is not None:
        voice_settings["stability"] = req.stability
    if req.similarity_boost is not None:
        voice_settings["similarity_boost"] = req.similarity_boost
    if req.style is not None:
        voice_settings["style"] = req.style
    if voice_settings:
        payload["voice_settings"] = voice_settings

    dict_meta: dict[str, Any] = {"applied": False, "locators": []}
    if model_pls_supported(cfg, req.model_id) and (
        req.use_dictionary or req.use_english_dictionary
    ):
        locators = resolve_tts_locators(
            cfg,
            req.model_id,
            use_anzellan=req.use_dictionary,
            use_english=req.use_english_dictionary,
        )
        if locators:
            payload["pronunciation_dictionary_locators"] = locators
            models = {m["id"]: m for m in cfg.get("models", [])}
            dict_meta = {
                "applied": True,
                "mode": models.get(req.model_id, {}).get("dict_mode"),
                "locators": locators,
                "locator": locators[0],
            }

    try:
        # trust_env=False: ignore broken HTTP(S)_PROXY from IDE sandboxes
        with httpx.Client(timeout=180.0, trust_env=False) as client:
            resp = client.post(
                f"{API_BASE}/v1/text-to-speech/{req.voice_id}",
                headers={
                    "xi-api-key": key,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                json=payload,
            )
            if resp.status_code >= 400:
                raise HTTPException(
                    status_code=502,
                    detail=f"ElevenLabs error {resp.status_code}: {resp.text[:800]}",
                )
            audio = resp.content
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs request failed: {exc}",
        ) from exc

    headers = {
        "Content-Disposition": 'inline; filename="anzellan_tts.mp3"',
        "X-Dict-Applied": "1" if dict_meta.get("applied") else "0",
        "X-Model-Id": req.model_id,
    }
    if dict_meta.get("locator"):
        headers["X-Dict-Id"] = dict_meta["locator"]["pronunciation_dictionary_id"]
        if dict_meta["locator"].get("version_id"):
            headers["X-Dict-Version"] = dict_meta["locator"]["version_id"]
    return Response(content=audio, media_type="audio/mpeg", headers=headers)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8787"))
    uvicorn.run("app:app", host=host, port=port, reload=True)
