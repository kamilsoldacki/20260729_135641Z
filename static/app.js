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
  lexiconLoadToken: 0,
  ipaPlsName: null,
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
  const checkbox = $("#use-dict");
  const label = $("#use-dict-label");
  const wrap = $("#use-dict-wrap");
  const row = $("#use-dict-row") || wrap?.closest(".field.row");
  const title = $("#dict-title");

  if (title) title.textContent = "Active dictionary";
  if (label) label.textContent = "Pronunciation dictionary";
  if (!checkbox) return;

  // v3: locators when checked. v4: auto-IPA rewrite when checked.
  if (row) row.hidden = false;
  checkbox.disabled = false;
  wrap?.classList.remove("is-disabled");
  if (!checkbox.dataset.userTouched) checkbox.checked = true;
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
  const entries = state.lexiconEntries;

  $("#rules-count").textContent = "Entries";
  $("#rules-value-head").textContent =
    state.lexiconKind === "alias" ? "Alias" : "Phoneme (IPA)";

  body.replaceChildren();
  if (!entries.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "rules-empty";
    td.textContent = "No entries loaded.";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="g">${escapeHtml(entry.grapheme)}</td><td class="arrow" aria-hidden="true">→</td><td class="v">${escapeHtml(entry.value)}</td>`;
    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

function ipaRewritePlsCandidates() {
  const phoneme = safePlsBasename(state.config.pronunciation?.phoneme?.pls_file);
  const alias = safePlsBasename(state.config.pronunciation?.alias?.pls_file);
  return [...new Set([phoneme, alias].filter(Boolean))];
}

async function fetchPlsEntries(plsName) {
  const res = await fetch(`/data/${plsName}`);
  if (!res.ok) throw new Error(`Failed to load ${plsName}`);
  return parsePls(await res.text());
}

/** Prefer phoneme EXACT DOCX PLS; fall back to alias PLS. */
async function loadIpaRewriteEntries() {
  for (const plsName of ipaRewritePlsCandidates()) {
    try {
      const entries = await fetchPlsEntries(plsName);
      if (!entries.length) continue;
      return {
        entries,
        plsName,
        kind: entries[0]?.kind || (plsName.toLowerCase().includes("alias") ? "alias" : "phoneme"),
      };
    } catch {
      /* try next candidate */
    }
  }
  return { entries: [], plsName: null, kind: "phoneme" };
}

function wrapInlineIpa(value) {
  const cleaned = String(value || "").replace(/^\/+|\/+$/g, "").trim();
  return cleaned ? `/${cleaned}/` : "";
}

/**
 * Rewrite orthographic words to ElevenLabs v4 inline IPA (/…/).
 * Longest whole-word match; exact case from PLS first, then case-insensitive.
 * Leaves existing /…/ spans untouched.
 */
function applyInlineIpaFromEntries(text, entries) {
  if (!text || !entries?.length) return { text, replacements: 0 };

  const byExact = new Map();
  const byLower = new Map();
  for (const entry of entries) {
    const grapheme = entry.grapheme;
    if (!grapheme) continue;
    if (!byExact.has(grapheme)) byExact.set(grapheme, entry.value);
    const lower = grapheme.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, entry.value);
  }

  const protectedSpans = [];
  let work = String(text).replace(/\/[^/\n]+\//g, (match) => {
    const idx = protectedSpans.length;
    protectedSpans.push(match);
    return `\0IPA${idx}\0`;
  });

  let replacements = 0;
  work = work.replace(/\p{L}[\p{L}\p{M}']*/gu, (word) => {
    let value = byExact.get(word);
    if (value == null) value = byLower.get(word.toLowerCase());
    if (value == null) return word;
    const wrapped = wrapInlineIpa(value);
    if (!wrapped) return word;
    replacements += 1;
    return wrapped;
  });

  work = work.replace(/\0IPA(\d+)\0/g, (_, idx) => protectedSpans[Number(idx)] || "");
  return { text: work, replacements };
}

function clientDictNote() {
  const meta = modelMeta();
  if (meta.note) return meta.note;
  if (!plsSupported()) {
    return [
      "Pronunciation applied automatically.",
      "Full PLS dictionary support with the public v4 release.",
    ].join("\n");
  }
  return "Works now · alias + phonemes (PLS applied)";
}

function updateDictCard() {
  const note = clientDictNote();
  const body = $("#dict-body");
  if (body) body.textContent = note;
  const metaEl = $("#lexicon-meta");
  if (metaEl) metaEl.textContent = note;
}

async function loadActiveLexicon() {
  const token = ++state.lexiconLoadToken;
  syncDictControls();
  updateDictCard();

  $("#rules-body").innerHTML =
    '<tr><td colspan="3" class="rules-empty">Loading dictionary…</td></tr>';

  if (!plsSupported()) {
    try {
      const loaded = await loadIpaRewriteEntries();
      if (token !== state.lexiconLoadToken) return;
      state.lexiconEntries = loaded.entries;
      state.lexiconKind = loaded.kind;
      state.ipaPlsName = loaded.plsName;
      renderLexiconRules();
      updateDictCard();
    } catch (err) {
      if (token !== state.lexiconLoadToken) return;
      state.lexiconEntries = [];
      state.lexiconKind = "phoneme";
      state.ipaPlsName = null;
      renderLexiconRules();
      $("#lexicon-meta").textContent = "Could not load pronunciation entries.";
    }
    return;
  }

  const mode = currentDictMode();
  const block = currentDictBlock();
  const plsName = safePlsBasename(block.pls_file);
  state.ipaPlsName = null;

  if (!plsName) {
    state.lexiconEntries = [];
    state.lexiconKind = mode === "alias" ? "alias" : "phoneme";
    renderLexiconRules();
    updateDictCard();
    return;
  }

  try {
    const entries = await fetchPlsEntries(plsName);
    if (token !== state.lexiconLoadToken) return;
    state.lexiconEntries = entries;
    state.lexiconKind = entries[0]?.kind || (mode === "alias" ? "alias" : "phoneme");
    renderLexiconRules();
    updateDictCard();
  } catch (err) {
    if (token !== state.lexiconLoadToken) return;
    state.lexiconEntries = [];
    state.lexiconKind = mode === "alias" ? "alias" : "phoneme";
    renderLexiconRules();
    $("#lexicon-meta").textContent = "Could not load pronunciation entries.";
  }
}

function fillVoices() {
  const sel = $("#voice");
  sel.innerHTML = "";
  const voices = state.config.voices || state.config.characters || [];

  if (!voices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No voices";
    sel.appendChild(opt);
  } else {
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label || v.id;
      sel.appendChild(opt);
    }
  }
  syncGenerateEnabled();

  const script = defaultScript();
  if (script && !$("#script").value.trim()) {
    $("#script").value = script;
  }
}

function bindLoadDefault() {
  const btn = $("#load-default");
  if (!btn) return;
  btn.addEventListener("click", () => {
    $("#script").value = defaultScript();
  });
}

function setModel(modelId) {
  state.modelId = modelId;
  document.querySelectorAll(".seg").forEach((el) => {
    el.classList.toggle("active", el.dataset.model === modelId);
  });
  delete $("#use-dict").dataset.userTouched;
  loadActiveLexicon();
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function syncAudioUi() {
  const player = $("#player");
  const toggle = $("#audio-toggle");
  const icon = toggle?.querySelector(".audio-toggle-icon");
  const seek = $("#audio-seek");
  const cur = $("#audio-current");
  const dur = $("#audio-duration");
  if (!player) return;

  const duration = player.duration || 0;
  const current = player.currentTime || 0;
  if (dur) dur.textContent = formatTime(duration);
  if (cur) cur.textContent = formatTime(current);
  if (seek && !seek.dataset.seeking) {
    seek.value = String(duration ? Math.round((current / duration) * 1000) : 0);
  }
  const playing = !player.paused && !player.ended && Boolean(player.src);
  if (toggle) toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  if (icon) icon.textContent = playing ? "❚❚" : "▶";
}

function bindAudioPlayer() {
  const player = $("#player");
  const toggle = $("#audio-toggle");
  const seek = $("#audio-seek");
  if (!player || !toggle || !seek) return;

  toggle.addEventListener("click", async () => {
    if (!player.src) return;
    if (player.paused) {
      try {
        await player.play();
      } catch {
        /* autoplay may be blocked */
      }
    } else {
      player.pause();
    }
  });

  const endSeek = () => {
    delete seek.dataset.seeking;
  };
  seek.addEventListener("pointerdown", () => {
    seek.dataset.seeking = "1";
  });
  seek.addEventListener("pointerup", endSeek);
  seek.addEventListener("pointercancel", endSeek);
  seek.addEventListener("change", endSeek);
  seek.addEventListener("input", () => {
    const duration = player.duration || 0;
    if (!duration) return;
    player.currentTime = (Number(seek.value) / 1000) * duration;
    syncAudioUi();
  });

  for (const ev of ["timeupdate", "loadedmetadata", "durationchange", "play", "pause", "ended"]) {
    player.addEventListener(ev, syncAudioUi);
  }
}

function resolvedVoiceId() {
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
    setStatus("Select a voice from the list.", true);
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

  const useDict = $("#use-dict").checked;
  const applyIpa = useDict && !plsSupported();
  const body = {
    text,
    voice_id: voiceId,
    model_id: state.modelId,
    use_dictionary: useDict && plsSupported(),
  };

  const btn = $("#generate");
  btn.disabled = true;
  setStatus("Generating…");

  let ipaReplacements = 0;

  try {
    if (applyIpa) {
      setStatus("Applying pronunciation…");
      let entries = state.lexiconEntries;
      if (!entries.length) {
        const loaded = await loadIpaRewriteEntries();
        entries = loaded.entries;
        state.lexiconEntries = loaded.entries;
        state.lexiconKind = loaded.kind;
        state.ipaPlsName = loaded.plsName;
      }
      const rewritten = applyInlineIpaFromEntries(text, entries);
      body.text = rewritten.text;
      ipaReplacements = rewritten.replacements;
    }

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
    syncAudioUi();

    const dictApplied = res.headers.get("X-Dict-Applied") === "1";
    if (!useDict) {
      setStatus("Ready · dictionary off");
    } else if (dictApplied) {
      setStatus("Ready · dictionary on");
    } else if (applyIpa) {
      setStatus(
        ipaReplacements
          ? "Ready · pronunciation applied"
          : "Ready · pronunciation applied automatically",
      );
    } else {
      setStatus("Ready · dictionary off");
    }

    try {
      await player.play();
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
  document.querySelectorAll(".seg").forEach((el) => {
    el.addEventListener("click", () => setModel(el.dataset.model));
  });
  $("#use-dict").addEventListener("change", () => {
    $("#use-dict").dataset.userTouched = "1";
  });
  $("#generate").addEventListener("click", generate);
  $("#download").addEventListener("click", download);
  bindLoadDefault();
  bindAudioPlayer();
}

function showBootError(message) {
  const msg = String(message || "Failed to load.");
  const body = $("#dict-body");
  if (body) body.textContent = msg;
  const meta = $("#lexicon-meta");
  if (meta) meta.textContent = msg;
  const rules = $("#rules-body");
  if (rules) {
    rules.innerHTML =
      '<tr><td colspan="3" class="rules-empty"></td></tr>';
    const td = rules.querySelector("td");
    if (td) td.textContent = msg;
  }
  setStatus(msg, true);
}

async function init() {
  bind();
  try {
    state.config = await fetchConfig();
    fillVoices();
    renderOrthography();
    setModel("eleven_v3");
    if (!state.config.api_key_configured) {
      setStatus("Set ELEVENLABS_API_KEY in .env.", true);
    } else if (!(state.config.voices || state.config.characters || []).length) {
      setStatus("No voices configured.");
    }
  } catch (err) {
    showBootError(err.message || String(err));
  }
}

init();
