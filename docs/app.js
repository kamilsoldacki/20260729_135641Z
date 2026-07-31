const API_KEY = "__INJECT_KEY__";
/**
 * Deploy replaces ONLY this assignment value with "/<repo>".
 * Do not globally sed __BASE__ - that also rewrites the sentinel check and empties BASE.
 * Unreplaced placeholder -> relative ./ paths (local docs/ preview).
 */
const BASE_RAW = "__BASE__";
const BASE =
  !BASE_RAW || BASE_RAW === "__BASE__" ? "" : String(BASE_RAW).replace(/\/$/, "");
const API_BASE = "https://api.elevenlabs.io";
const ALLOWED_MODELS = new Set(["eleven_v3", "eleven_v4"]);
const VOICE_ID_RE = /^[A-Za-z0-9]{10,64}$/;
const ALIAS_CACHE_KEY = "tail_anzellan_alias_dict_v1";

const $ = (sel) => document.querySelector(sel);

function asset(path) {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return BASE ? `${BASE}/${clean}` : `./${clean}`;
}

const ORTHOGRAPHY_FALLBACK = [
  { from: "x", to: "ʃ" },
  { from: "dj", to: "dʒ" },
  { from: "g", to: "ɡ" },
  { from: "ie", to: "i̯e" },
  { from: "ei", to: "ei̯" },
  { from: "oi", to: "oi̯" },
  { from: "problem", to: "pobem" },
];

const state = {
  config: null,
  modelId: "eleven_v3",
  lastBlob: null,
  lastUrl: null,
  lexiconEntries: [],
  lexiconKind: "phoneme",
  lexiconLoadToken: 0,
  ipaPlsName: null,
  englishLexiconEntries: [],
  englishPlsName: null,
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

function apiKeyConfigured() {
  return Boolean(API_KEY && API_KEY !== "__INJECT_KEY__");
}

async function fetchConfig() {
  const res = await fetch(asset("config.json"));
  if (!res.ok) throw new Error("Failed to load config.json");
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

function currentDictMode() {
  if (!plsSupported()) return "inline_ipa";
  return modelMeta().dict_mode || (state.modelId === "eleven_v3" ? "phoneme" : "phoneme");
}

function currentDictBlock() {
  const mode = currentDictMode();
  if (mode === "inline_ipa") return {};
  return mode === "alias"
    ? aliasBlockResolved()
    : state.config.pronunciation?.phoneme || {};
}

function syncDictControls() {
  const checkbox = $("#use-dict");
  const label = $("#use-dict-label");
  const wrap = $("#use-dict-wrap");
  const row = $("#use-dict-row") || wrap?.closest(".field");
  const englishBox = $("#use-english-ipa");
  const englishWrap = $("#use-english-ipa-wrap");

  if (label) label.textContent = "Anzellan IPA";
  if (!checkbox) return;

  // v3: locators when checked. v4: auto-IPA rewrite when checked.
  if (row) row.hidden = false;
  checkbox.disabled = false;
  wrap?.classList.remove("is-disabled");
  if (!checkbox.dataset.userTouched) checkbox.checked = true;

  if (englishBox) {
    englishBox.disabled = false;
    englishWrap?.classList.remove("is-disabled");
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
  const res = await fetch(asset(`data/${plsName}`));
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

async function loadEnglishIpaEntries() {
  if (state.englishLexiconEntries.length) {
    return {
      entries: state.englishLexiconEntries,
      plsName: state.englishPlsName,
    };
  }
  const plsName = safePlsBasename(state.config.pronunciation?.english?.pls_file);
  if (!plsName) return { entries: [], plsName: null };
  const entries = await fetchPlsEntries(plsName);
  state.englishLexiconEntries = entries;
  state.englishPlsName = plsName;
  return { entries, plsName };
}

/**
 * Apply optional Anzellan (v4 inline) then English IPA rewrites.
 * Existing /…/ spans stay protected; Anzellan wins on overlapping words.
 */
async function applySelectedIpaRewrites(text, { applyAnzellanInline, applyEnglish }) {
  let out = text;
  let replacements = 0;
  const parts = [];

  if (applyAnzellanInline) {
    let entries = state.lexiconEntries;
    if (!entries.length) {
      const loaded = await loadIpaRewriteEntries();
      entries = loaded.entries;
      state.lexiconEntries = loaded.entries;
      state.lexiconKind = loaded.kind;
      state.ipaPlsName = loaded.plsName;
    }
    const rewritten = applyInlineIpaFromEntries(out, entries);
    out = rewritten.text;
    replacements += rewritten.replacements;
    if (rewritten.replacements) parts.push("Anzellan");
  }

  if (applyEnglish) {
    const loaded = await loadEnglishIpaEntries();
    const rewritten = applyInlineIpaFromEntries(out, loaded.entries);
    out = rewritten.text;
    replacements += rewritten.replacements;
    if (rewritten.replacements) parts.push("English");
  }

  return { text: out, replacements, parts };
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
  // Include hyphens so Anzellan forms like ga-no / ked-ba match PLS graphemes.
  work = work.replace(/\p{L}[\p{L}\p{M}'-]*/gu, (word) => {
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
    return "v4 preview · inline /IPA/ + text normalizer off (no PLS locators).";
  }
  return "Works now · alias + phonemes (PLS applied)";
}

function updateDictCard() {
  const note = clientDictNote();
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
  const custom = ($("#voice-id-custom")?.value || "").trim();
  if (custom) return custom;
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
    "Anzellan alias lexicon for non-phoneme models.",
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
  const meta = models[modelId] || {};
  const supported =
    typeof meta.pls_supported === "boolean"
      ? meta.pls_supported
      : modelId === "eleven_v3";
  if (!supported) {
    throw new Error("PLS dictionaries are not available for this model yet.");
  }

  let mode = meta.dict_mode;
  if (mode !== "phoneme" && mode !== "alias") {
    mode = "phoneme";
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

function englishLocator() {
  const block = state.config.pronunciation?.english || {};
  if (!block.dictionary_id) return null;
  const locator = { pronunciation_dictionary_id: block.dictionary_id };
  if (block.version_id) locator.version_id = block.version_id;
  return locator;
}

async function resolveSelectedLocators({ useAnzellan, useEnglish }) {
  const locators = [];
  if (useAnzellan) {
    const { locator } = await resolveDictLocator(state.modelId);
    locators.push(locator);
  }
  if (useEnglish) {
    const locator = englishLocator();
    if (locator) locators.push(locator);
  }
  return locators;
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
    setStatus("Select a voice from the list.", true);
    return;
  }
  if (!VOICE_ID_RE.test(voiceId)) {
    setStatus("Invalid voice in config.", true);
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

  const payload = {
    text,
    model_id: state.modelId,
  };
  // v4 IPA: inline /IPA/ requires the text normalizer off (no PLS locators).
  if (state.modelId === "eleven_v4") {
    payload.apply_text_normalization = "off";
  }

  const btn = $("#generate");
  btn.disabled = true;
  setStatus("Generating…");

  const useDict = $("#use-dict").checked;
  const useEnglishIpa = Boolean($("#use-english-ipa")?.checked);
  // v3: phoneme PLS locators. v4: client inline /IPA/ (phoneme PLS unsupported).
  const attachAnzellan = useDict && plsSupported();
  const attachEnglish =
    useEnglishIpa && plsSupported() && Boolean(englishLocator());
  const applyAnzellanInline = useDict && !plsSupported();
  const applyEnglishInline = useEnglishIpa && !attachEnglish;

  try {
    if (applyAnzellanInline || applyEnglishInline) {
      setStatus("Applying pronunciation…");
      const rewritten = await applySelectedIpaRewrites(text, {
        applyAnzellanInline,
        applyEnglish: applyEnglishInline,
      });
      payload.text = rewritten.text;
    }

    if (attachAnzellan || attachEnglish) {
      payload.pronunciation_dictionary_locators = await resolveSelectedLocators({
        useAnzellan: attachAnzellan,
        useEnglish: attachEnglish,
      });
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
    syncAudioUi();

    // ElevenLabs TTS does not return X-Dict-Applied (that header is only from our
    // FastAPI /api/tts proxy). Pages calls EL directly, so treat dictionary as
    // applied when locators were attached to the request and the response was OK.
    const dictApplied = Array.isArray(payload.pronunciation_dictionary_locators)
      && payload.pronunciation_dictionary_locators.length > 0;

    const labels = [
      ...(useDict && (attachAnzellan || applyAnzellanInline || dictApplied) ? ["Anzellan"] : []),
      ...(useEnglishIpa ? ["English"] : []),
    ];
    if (!labels.length) {
      setStatus("Ready · dictionary off");
    } else {
      setStatus(`Ready · ${labels.join(" + ")} IPA`);
    }

    try {
      await player.play();
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
  $("#voice").addEventListener("change", syncGenerateEnabled);
  $("#voice-id-custom").addEventListener("input", syncGenerateEnabled);
  document.querySelectorAll(".seg").forEach((el) => {
    el.addEventListener("click", () => setModel(el.dataset.model));
  });
  $("#use-dict").addEventListener("change", () => {
    $("#use-dict").dataset.userTouched = "1";
  });
  $("#use-english-ipa")?.addEventListener("change", () => {
    $("#use-english-ipa").dataset.userTouched = "1";
  });
  $("#generate").addEventListener("click", generate);
  $("#download").addEventListener("click", download);
  bindLoadDefault();
  bindAudioPlayer();
}

function showBootError(message) {
  const msg = String(message || "Failed to load.");
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
    if (!apiKeyConfigured()) {
      setStatus("Missing API key — deploy with GitHub Actions.", true);
    } else if (!(state.config.voices || state.config.characters || []).length) {
      setStatus("No voices configured.");
    }
  } catch (err) {
    showBootError(err.message || String(err));
  }
}

init();
