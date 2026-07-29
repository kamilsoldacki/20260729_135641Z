const API_KEY = "__INJECT_KEY__";
/** Deploy replaces __BASE__ with /<repo>; left as placeholder → relative ./ paths. */
const BASE_RAW = "__BASE__";
const BASE = (BASE_RAW === "__BASE__" || !BASE_RAW ? "" : BASE_RAW).replace(/\/$/, "");
const API_BASE = "https://api.elevenlabs.io";
const ALLOWED_MODELS = new Set(["eleven_v3", "eleven_v4"]);
const VOICE_ID_RE = /^[A-Za-z0-9]{10,64}$/;
const ALIAS_CACHE_KEY = "tail_anzellan_alias_dict_v1";

const $ = (sel) => document.querySelector(sel);

function asset(path) {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return BASE ? `${BASE}/${clean}` : `./${clean}`;
}

const state = {
  config: null,
  modelId: "eleven_v3",
  lastBlob: null,
  lastUrl: null,
};

function apiKeyConfigured() {
  return Boolean(API_KEY && API_KEY !== "__INJECT_KEY__");
}

async function fetchConfig() {
  const res = await fetch(asset("config.json"));
  if (!res.ok) throw new Error("Failed to load config.json");
  return res.json();
}

function currentCharacter() {
  const id = $("#character").value;
  return state.config.characters.find((c) => c.id === id);
}

function modelMeta() {
  return (state.config.models || []).find((m) => m.id === state.modelId) || {};
}

function readAliasCache() {
  try {
    const raw = localStorage.getItem(ALIAS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeAliasCache(entry) {
  localStorage.setItem(ALIAS_CACHE_KEY, JSON.stringify(entry));
}

function aliasBlockResolved() {
  const block = { ...(state.config.pronunciation?.alias || {}) };
  if (!block.dictionary_id) {
    const cached = readAliasCache();
    if (cached?.dictionary_id) {
      block.dictionary_id = cached.dictionary_id;
      block.version_id = cached.version_id || null;
    }
  }
  return block;
}

function updateDictCard() {
  const mode = modelMeta().dict_mode || (state.modelId === "eleven_v3" ? "phoneme" : "alias");
  const block =
    mode === "alias" ? aliasBlockResolved() : state.config.pronunciation?.phoneme || {};
  const lines = [
    block.name || mode,
    `id: ${block.dictionary_id || "(auto-create on first v4 generate)"}`,
  ];
  if (block.version_id) lines.push(`version: ${block.version_id}`);
  if (block.pls_file) lines.push(`pls: ${block.pls_file}`);
  $("#dict-body").textContent = lines.join("\n");
}

function fillCharacters() {
  const sel = $("#character");
  sel.innerHTML = "";
  for (const c of state.config.characters) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
}

function fillVoices() {
  const char = currentCharacter();
  const sel = $("#voice");
  sel.innerHTML = "";
  const voices = char?.voices || [];
  $("#traits").textContent = char?.traits || "";

  if (!voices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— no voices in config —";
    sel.appendChild(opt);
    $("#voice-hint").hidden = false;
  } else {
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      const bits = [v.label || v.id];
      if (v.tier) bits.push(v.tier);
      if (v.pack) bits.push(v.pack);
      opt.textContent = bits.join(" · ");
      sel.appendChild(opt);
    }
    $("#voice-hint").hidden = true;
  }
  syncGenerateEnabled();

  const key = char?.default_script_key;
  if (key && state.config.sample_scripts?.[key]) {
    $("#script").value = state.config.sample_scripts[key];
  }
}

function fillScriptChips() {
  const wrap = $("#script-chips");
  wrap.innerHTML = "";
  const bilingual = state.config.sample_scripts?.docx_bilingual || [];
  for (const line of bilingual) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = line.length > 28 ? line.slice(0, 26) + "…" : line;
    btn.title = line;
    btn.addEventListener("click", () => {
      const ta = $("#script");
      ta.value = ta.value.trim() ? `${ta.value.trim()}\n${line}` : line;
      ta.focus();
    });
    wrap.appendChild(btn);
  }
  const loadDefault = document.createElement("button");
  loadDefault.type = "button";
  loadDefault.className = "chip";
  loadDefault.textContent = "Load character default";
  loadDefault.addEventListener("click", () => {
    const char = currentCharacter();
    const key = char?.default_script_key;
    if (key && state.config.sample_scripts?.[key]) {
      $("#script").value = state.config.sample_scripts[key];
    }
  });
  wrap.appendChild(loadDefault);
}

function setModel(modelId) {
  state.modelId = modelId;
  document.querySelectorAll(".seg").forEach((el) => {
    el.classList.toggle("active", el.dataset.model === modelId);
  });
  $("#model-note").textContent = modelMeta().note || "";
  updateDictCard();
}

function resolvedVoiceId() {
  const manual = ($("#voice-manual").value || "").trim();
  if (manual) return manual;
  return ($("#voice").value || "").trim();
}

function syncGenerateEnabled() {
  const hasVoice = Boolean(resolvedVoiceId());
  $("#generate").disabled = !hasVoice || !apiKeyConfigured();
}

function setStatus(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg || "";
  el.classList.toggle("error", Boolean(isError));
}

function revokeLastUrl() {
  if (state.lastUrl) {
    URL.revokeObjectURL(state.lastUrl);
    state.lastUrl = null;
  }
}

async function ensureAliasDictionary() {
  const cached = readAliasCache();
  if (cached?.dictionary_id) return cached;

  const block = state.config.pronunciation?.alias || {};
  const plsFile = block.pls_file || "anzellan_pronunciation_ALIAS_v4.pls";
  const plsRes = await fetch(asset(`data/${plsFile}`));
  if (!plsRes.ok) throw new Error(`Missing PLS file: ${plsFile}`);
  const plsBlob = await plsRes.blob();

  const form = new FormData();
  form.append("file", plsBlob, plsFile);
  form.append("name", `Anzellan_ALIAS_v4_${plsFile.replace(/\.pls$/i, "")}`);
  form.append(
    "description",
    "Anzellan alias lexicon for models that skip phoneme tags (TAIL DOCX).",
  );

  const resp = await fetch(`${API_BASE}/v1/pronunciation-dictionaries/add-from-file`, {
    method: "POST",
    headers: { "xi-api-key": API_KEY },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create alias dictionary: ${text.slice(0, 400)}`);
  }
  const body = await resp.json();
  const entry = {
    dictionary_id: body.id,
    version_id: body.version_id || null,
    name: body.name || block.name,
  };
  writeAliasCache(entry);
  return entry;
}

async function resolveDictLocator(modelId) {
  const models = Object.fromEntries((state.config.models || []).map((m) => [m.id, m]));
  let mode = models[modelId]?.dict_mode;
  if (mode !== "phoneme" && mode !== "alias") {
    mode = modelId === "eleven_v3" ? "phoneme" : "alias";
  }

  if (mode === "phoneme") {
    const block = state.config.pronunciation?.phoneme || {};
    if (!block.dictionary_id) {
      throw new Error("No pronunciation dictionary configured for phoneme mode.");
    }
    const locator = { pronunciation_dictionary_id: block.dictionary_id };
    if (block.version_id) locator.version_id = block.version_id;
    return { mode, locator };
  }

  let block = aliasBlockResolved();
  if (!block.dictionary_id) {
    if (!block.auto_create) {
      throw new Error("No pronunciation dictionary configured for alias mode.");
    }
    const created = await ensureAliasDictionary();
    block = { ...block, ...created };
    updateDictCard();
  }
  const locator = { pronunciation_dictionary_id: block.dictionary_id };
  if (block.version_id) locator.version_id = block.version_id;
  return { mode, locator };
}

async function parseApiError(res) {
  let detail = `API error (${res.status})`;
  try {
    const errJson = await res.json();
    detail =
      errJson.detail?.message ||
      errJson.detail ||
      errJson.message ||
      JSON.stringify(errJson);
  } catch {
    try {
      const errText = await res.text();
      if (errText) detail = errText.slice(0, 400);
    } catch {
      /* ignore */
    }
  }
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

async function generate() {
  const voiceId = resolvedVoiceId();
  const text = $("#script").value.trim();
  if (!apiKeyConfigured()) {
    setStatus("Missing API key — deploy with GitHub Actions.", true);
    return;
  }
  if (!voiceId) {
    setStatus("Paste a voice_id or add entries in docs/config.json.", true);
    return;
  }
  if (!VOICE_ID_RE.test(voiceId)) {
    setStatus("Invalid voice_id format.", true);
    return;
  }
  if (!text) {
    setStatus("Script is empty.", true);
    return;
  }
  if (!ALLOWED_MODELS.has(state.modelId)) {
    setStatus("Model not allowed.", true);
    return;
  }

  const seedRaw = $("#seed").value.trim();
  const payload = {
    text,
    model_id: state.modelId,
  };
  if (seedRaw !== "") {
    const seed = Number(seedRaw);
    if (!Number.isFinite(seed) || seed < 0) {
      setStatus("Seed must be a non-negative number.", true);
      return;
    }
    payload.seed = seed;
  }

  const btn = $("#generate");
  btn.disabled = true;
  setStatus(`Generating with ${state.modelId}…`);
  $("#wave").classList.remove("playing");

  let dictApplied = false;
  let dictId = "";

  try {
    if ($("#use-dict").checked) {
      const { locator } = await resolveDictLocator(state.modelId);
      payload.pronunciation_dictionary_locators = [locator];
      dictApplied = true;
      dictId = locator.pronunciation_dictionary_id || "";
    }

    const res = await fetch(
      `${API_BASE}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) throw new Error(await parseApiError(res));

    const blob = await res.blob();
    revokeLastUrl();
    state.lastBlob = blob;
    state.lastUrl = URL.createObjectURL(blob);

    const player = $("#player");
    player.src = state.lastUrl;
    $("#player-wrap").hidden = false;
    $("#download").disabled = false;

    setStatus(dictApplied ? `Ready · dict ${dictId || "on"}` : "Ready · dictionary off");

    try {
      await player.play();
      $("#wave").classList.add("playing");
    } catch {
      /* autoplay may be blocked */
    }
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    syncGenerateEnabled();
  }
}

function download() {
  if (!state.lastBlob) return;
  const a = document.createElement("a");
  a.href = state.lastUrl;
  a.download = `tail_anzellan_${state.modelId}_${Date.now()}.mp3`;
  a.click();
}

function bind() {
  $("#character").addEventListener("change", fillVoices);
  $("#voice").addEventListener("change", syncGenerateEnabled);
  $("#voice-manual").addEventListener("input", syncGenerateEnabled);
  document.querySelectorAll(".seg").forEach((el) => {
    el.addEventListener("click", () => setModel(el.dataset.model));
  });
  $("#generate").addEventListener("click", generate);
  $("#download").addEventListener("click", download);

  const player = $("#player");
  player.addEventListener("play", () => $("#wave").classList.add("playing"));
  player.addEventListener("pause", () => $("#wave").classList.remove("playing"));
  player.addEventListener("ended", () => $("#wave").classList.remove("playing"));
}

async function init() {
  bind();
  try {
    state.config = await fetchConfig();
    $("#brand").textContent = state.config.brand || "TAIL";
    $("#subtitle").textContent = state.config.title || "Anzellan Voice Lab";
    document.title = `${state.config.brand || "TAIL"} — ${state.config.title || "Anzellan Voice Lab"}`;
    fillCharacters();
    fillVoices();
    fillScriptChips();
    setModel("eleven_v3");
    if (!apiKeyConfigured()) {
      setStatus("Missing API key — deploy with GitHub Actions (secret ELEVENLABS_API_KEY).", true);
    } else if (!(currentCharacter()?.voices || []).length) {
      setStatus("Voices empty — paste IDs into docs/config.json when you have them.");
    }
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

init();
