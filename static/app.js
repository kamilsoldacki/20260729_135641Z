const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  modelId: "eleven_v3",
  lastBlob: null,
  lastUrl: null,
};

async function fetchConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}

function currentCharacter() {
  const id = $("#character").value;
  return state.config.characters.find((c) => c.id === id);
}

function modelMeta() {
  return (state.config.models || []).find((m) => m.id === state.modelId) || {};
}

function updateDictCard() {
  const mode = modelMeta().dict_mode || (state.modelId === "eleven_v3" ? "phoneme" : "alias");
  const block = state.config.pronunciation[mode] || {};
  const lines = [
    block.name || mode,
    `id: ${block.dictionary_id || block.id || "(auto-create on first v4 generate)"}`,
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
  $("#generate").disabled = !hasVoice || !state.config?.api_key_configured;
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

async function generate() {
  const voiceId = resolvedVoiceId();
  const text = $("#script").value.trim();
  if (!voiceId) {
    setStatus("Paste a voice_id or add entries in config/voices.json.", true);
    return;
  }
  if (!text) {
    setStatus("Script is empty.", true);
    return;
  }
  if (!state.config.api_key_configured) {
    setStatus("Set ELEVENLABS_API_KEY in .env and restart.", true);
    return;
  }

  const seedRaw = $("#seed").value.trim();
  const body = {
    text,
    voice_id: voiceId,
    model_id: state.modelId,
    use_dictionary: $("#use-dict").checked,
  };
  if (seedRaw !== "") body.seed = Number(seedRaw);

  const btn = $("#generate");
  btn.disabled = true;
  setStatus(`Generating with ${state.modelId}…`);
  $("#wave").classList.remove("playing");

  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        detail = err.detail || detail;
      } catch (_) {
        /* ignore */
      }
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }

    const blob = await res.blob();
    revokeLastUrl();
    state.lastBlob = blob;
    state.lastUrl = URL.createObjectURL(blob);

    const player = $("#player");
    player.src = state.lastUrl;
    $("#player-wrap").hidden = false;
    $("#download").disabled = false;

    const dictApplied = res.headers.get("X-Dict-Applied") === "1";
    const dictId = res.headers.get("X-Dict-Id") || "";
    setStatus(
      dictApplied
        ? `Ready · dict ${dictId || "on"}`
        : "Ready · dictionary off",
    );

    try {
      await player.play();
      $("#wave").classList.add("playing");
    } catch (_) {
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
    if (!state.config.api_key_configured) {
      setStatus("Copy .env.example → .env and set ELEVENLABS_API_KEY.", true);
    } else if (!(currentCharacter()?.voices || []).length) {
      setStatus("Voices empty — paste IDs into config/voices.json when you have them.");
    }
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

init();
