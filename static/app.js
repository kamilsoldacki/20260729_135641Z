const ORTHOGRAPHY_FALLBACK = [
  { from: "x", to: "ʃ" },
  { from: "dj", to: "dʒ" },
  { from: "g", to: "ɡ" },
  { from: "ie", to: "i̯e" },
  { from: "ei", to: "ei̯" },
  { from: "oi", to: "oi̯" },
  { from: "problem", to: "pobem" },
];

const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  modelId: "eleven_v3",
  lastBlob: null,
  lastUrl: null,
  lexiconEntries: [],
  lexiconKind: "phoneme",
  lexiconFilter: "",
  lexiconLoadToken: 0,
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safePlsBasename(name) {
  const base = String(name || "").replace(/^.*[\\/]/, "").trim();
  if (!base || base.includes("..") || !/\.pls$/i.test(base)) return null;
  return base;
}

function parsePls(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid PLS XML");
  }
  const entries = [];
  for (const lex of doc.getElementsByTagName("lexeme")) {
    const grapheme = lex.getElementsByTagName("grapheme")[0]?.textContent?.trim() || "";
    const phoneme = lex.getElementsByTagName("phoneme")[0]?.textContent?.trim() || "";
    const alias = lex.getElementsByTagName("alias")[0]?.textContent?.trim() || "";
    if (!grapheme) continue;
    const value = phoneme || alias;
    if (!value) continue;
    entries.push({
      grapheme,
      value,
      kind: phoneme ? "phoneme" : "alias",
    });
  }
  return entries;
}

async function fetchConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}

function modelMeta() {
  return (state.config.models || []).find((m) => m.id === state.modelId) || {};
}

function plsSupported() {
  const meta = modelMeta();
  if (typeof meta.pls_supported === "boolean") return meta.pls_supported;
  return state.modelId === "eleven_v3";
}

function currentDictMode() {
  if (!plsSupported()) return "inline_ipa";
  return modelMeta().dict_mode || "phoneme";
}

function currentDictBlock() {
  const mode = currentDictMode();
  if (mode === "inline_ipa") return {};
  return state.config.pronunciation?.[mode] || {};
}

function syncDictControls() {
  const supported = plsSupported();
  const checkbox = $("#use-dict");
  const label = $("#use-dict-label");
  const wrap = $("#use-dict-wrap");
  const title = $("#dict-title");
  const note = $("#model-note");
  const meta = modelMeta();

  note.textContent = meta.note || "";

  if (supported) {
    checkbox.disabled = false;
    wrap?.classList.remove("is-disabled");
    if (!checkbox.dataset.userTouched) checkbox.checked = true;
    label.textContent = "Pronunciation dictionary";
    title.textContent = "Active dictionary";
  } else {
    checkbox.checked = false;
    checkbox.disabled = true;
    wrap?.classList.add("is-disabled");
    label.textContent = "Inline IPA in script";
    title.textContent = "Pronunciation";
  }
}

function defaultScript() {
  return state.config.sample_scripts?.default || "";
}

function renderOrthography() {
  const list = $("#ortho-list");
  const rules = state.config.orthography?.length
    ? state.config.orthography
    : ORTHOGRAPHY_FALLBACK;
  list.replaceChildren();
  for (const rule of rules) {
    const li = document.createElement("li");
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = rule.from;
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    const to = document.createElement("span");
    to.className = "to";
    to.textContent = rule.to;
    li.append(from, arrow, to);
    list.appendChild(li);
  }
}

function renderLexiconRules() {
  const body = $("#rules-body");
  const filter = state.lexiconFilter.trim().toLowerCase();
  const visible = filter
    ? state.lexiconEntries.filter(
        (e) =>
          e.grapheme.toLowerCase().includes(filter) ||
          e.value.toLowerCase().includes(filter),
      )
    : state.lexiconEntries;

  $("#rules-count").textContent = filter
    ? `${visible.length} / ${state.lexiconEntries.length} entries`
    : `${state.lexiconEntries.length} entries`;
  $("#rules-value-head").textContent =
    state.lexiconKind === "alias" ? "Alias" : "Phoneme (IPA)";

  body.replaceChildren();
  if (!visible.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "rules-empty";
    td.textContent = state.lexiconEntries.length
      ? "No entries match this filter."
      : "No entries loaded.";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const entry of visible) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="g">${escapeHtml(entry.grapheme)}</td><td class="arrow" aria-hidden="true">→</td><td class="v">${escapeHtml(entry.value)}</td>`;
    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

function updateDictCard() {
  if (!plsSupported()) {
    $("#dict-body").textContent = [
      "Preview model",
      "PLS dictionaries arrive with the public v4 release.",
      "Tip: put IPA in slashes in the script, e.g. /ˈnaɪki/.",
    ].join("\n");
    $("#lexicon-meta").textContent = "Inline IPA · PLS with public v4";
    return;
  }

  const mode = currentDictMode();
  const block = currentDictBlock();
  const lines = [
    block.name || mode,
    `mode: ${mode}`,
    `id: ${block.dictionary_id || block.id || "(not configured)"}`,
  ];
  if (block.version_id) lines.push(`version: ${block.version_id}`);
  if (block.pls_file) lines.push(`pls: ${block.pls_file}`);
  $("#dict-body").textContent = lines.join("\n");

  const metaBits = [block.name || mode, mode];
  if (block.pls_file) metaBits.push(block.pls_file);
  $("#lexicon-meta").textContent = metaBits.join(" · ");
}

function renderInlineIpaPanel() {
  state.lexiconEntries = [];
  state.lexiconKind = "phoneme";
  $("#rules-count").textContent = "Inline IPA";
  $("#rules-value-head").textContent = "Phoneme (IPA)";
  const body = $("#rules-body");
  body.replaceChildren();
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 3;
  td.className = "rules-empty";
  td.textContent =
    "PLS not wired on preview v4 yet. Use inline IPA in the script (e.g. /ˈnaɪki/). Full dictionaries arrive with the public v4 release.";
  tr.appendChild(td);
  body.appendChild(tr);
}

async function loadActiveLexicon() {
  const token = ++state.lexiconLoadToken;
  syncDictControls();
  updateDictCard();

  if (!plsSupported()) {
    renderInlineIpaPanel();
    return;
  }

  const mode = currentDictMode();
  const block = currentDictBlock();
  const plsName = safePlsBasename(block.pls_file);

  if (!plsName) {
    state.lexiconEntries = [];
    state.lexiconKind = mode === "alias" ? "alias" : "phoneme";
    renderLexiconRules();
    $("#lexicon-meta").textContent = `${block.name || mode} · no PLS file configured`;
    return;
  }

  $("#rules-body").innerHTML =
    '<tr><td colspan="3" class="rules-empty">Loading dictionary…</td></tr>';

  try {
    const res = await fetch(`/data/${plsName}`);
    if (!res.ok) throw new Error(`Failed to load ${plsName}`);
    const xml = await res.text();
    if (token !== state.lexiconLoadToken) return;
    const entries = parsePls(xml);
    state.lexiconEntries = entries;
    state.lexiconKind = entries[0]?.kind || (mode === "alias" ? "alias" : "phoneme");
    renderLexiconRules();
    $("#lexicon-meta").textContent = [
      block.name || mode,
      mode,
      plsName,
      `${entries.length} rules`,
    ].join(" · ");
  } catch (err) {
    if (token !== state.lexiconLoadToken) return;
    state.lexiconEntries = [];
    state.lexiconKind = mode === "alias" ? "alias" : "phoneme";
    renderLexiconRules();
    $("#lexicon-meta").textContent = `Could not load ${plsName}: ${err.message || err}`;
  }
}

function fillVoices() {
  const sel = $("#voice");
  sel.innerHTML = "";
  const voices = state.config.voices || [];

  if (!voices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No voices";
    sel.appendChild(opt);
    $("#voice-hint").hidden = false;
  } else {
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label || v.id;
      sel.appendChild(opt);
    }
    $("#voice-hint").hidden = true;
  }
  syncGenerateEnabled();

  const script = defaultScript();
  if (script && !$("#script").value.trim()) {
    $("#script").value = script;
  }
}

function fillScriptChips() {
  const wrap = $("#script-chips");
  wrap.innerHTML = "";
  const loadDefault = document.createElement("button");
  loadDefault.type = "button";
  loadDefault.className = "chip";
  loadDefault.textContent = "Load default";
  loadDefault.addEventListener("click", () => {
    $("#script").value = defaultScript();
  });
  wrap.appendChild(loadDefault);
}

function setModel(modelId) {
  state.modelId = modelId;
  document.querySelectorAll(".seg").forEach((el) => {
    el.classList.toggle("active", el.dataset.model === modelId);
  });
  delete $("#use-dict").dataset.userTouched;
  loadActiveLexicon();
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
    setStatus("Select or paste a voice ID.", true);
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
    use_dictionary: $("#use-dict").checked && plsSupported(),
  };
  if (seedRaw !== "") body.seed = Number(seedRaw);

  const btn = $("#generate");
  btn.disabled = true;
  setStatus("Generating…");
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
    if (dictApplied) {
      setStatus(`Ready · dictionary ${dictId || "on"}`);
    } else if (!plsSupported()) {
      setStatus("Ready · inline IPA (no PLS)");
    } else {
      setStatus("Ready · dictionary off");
    }

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
  $("#voice").addEventListener("change", syncGenerateEnabled);
  $("#voice-manual").addEventListener("input", syncGenerateEnabled);
  document.querySelectorAll(".seg").forEach((el) => {
    el.addEventListener("click", () => setModel(el.dataset.model));
  });
  $("#use-dict").addEventListener("change", () => {
    $("#use-dict").dataset.userTouched = "1";
  });
  $("#generate").addEventListener("click", generate);
  $("#download").addEventListener("click", download);
  $("#dict-filter").addEventListener("input", (ev) => {
    state.lexiconFilter = ev.target.value || "";
    if (plsSupported()) renderLexiconRules();
  });

  const player = $("#player");
  player.addEventListener("play", () => $("#wave").classList.add("playing"));
  player.addEventListener("pause", () => $("#wave").classList.remove("playing"));
  player.addEventListener("ended", () => $("#wave").classList.remove("playing"));
}

async function init() {
  bind();
  try {
    state.config = await fetchConfig();
    fillVoices();
    fillScriptChips();
    renderOrthography();
    setModel("eleven_v3");
    if (!state.config.api_key_configured) {
      setStatus("Set ELEVENLABS_API_KEY in .env.", true);
    } else if (!(state.config.voices || []).length) {
      setStatus("No voices configured.");
    }
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

init();
