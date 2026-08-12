/* ============================================================
   会议回放播放器 · Transcript 联动
   支持：按发言人分组显示、名字自动识别、段落/句子点击跳转
   ============================================================ */
'use strict';

/* ---------- 工具 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const PALETTE = ["#6264A7", "#0078D4", "#E3008C", "#107C10", "#CA5010", "#B146C2", "#038387", "#D13438", "#8764B8", "#498205"];

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtClock(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------- 状态 ---------- */
const state = {
  segments: [],      // 句子级逐字稿
  blocks: [],        // 按发言人合并后的块
  blockOfSeg: [],    // 每个句子属于哪个块
  speakers: {},
  speakerOrder: [],
  chapters: [],
  videoUrl: "",
  poster: "",
  title: "会议回放",
  date: "",
  participants: 0,
  duration: 0,
  activeIdx: -1,     // 当前句索引
  searchQuery: "",
  matches: [],
  matchCursor: -1,
  objectUrl: null,
  loadedVideo: false,
};

const settings = {
  autoScroll: true,
  theme: "light",
  rate: 1,
  fontSize: 13.5,
};
const SETTINGS_KEY = "teamsTranscriptPlayer.settings";
const IMPORT_KEY = "teamsTranscriptPlayer.import";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* ignore */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  $("#cfgDarkTheme").checked = settings.theme === "dark";
  $("#cfgAutoScroll").checked = settings.autoScroll;
  $("#btnScrollLock").classList.toggle("on", settings.autoScroll);
  $("#transcriptList").style.fontSize = settings.fontSize + "px";
  if (video.playbackRate !== settings.rate) video.playbackRate = settings.rate;
  updateSpeedBtn();
}

/* ---------- DOM ---------- */
const video = $("#video");
const videoShell = $("#videoShell");
const videoEmpty = $("#videoEmpty");
const videoError = $("#videoError");
const videoOverlay = $("#videoOverlay");
const transcriptList = $("#transcriptList");
const chaptersRow = $("#chaptersRow");
const chaptersBar = $("#chaptersBar");
const progress = $("#progress");
const progressPlayed = $("#progressPlayed");
const progressBuffered = $("#progressBuffered");
const progressThumb = $("#progressThumb");
const speedMenu = $("#speedMenu");

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove("out");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => (el.hidden = true), 350);
  }, 2600);
}/* ---------- 数据规范化 ---------- */
function resolveSpeakerId(spk, speakers) {
  // spk 可能是 key、名字、或 {name} 对象
  let name = "";
  if (spk && typeof spk === "object") name = String(spk.name || spk.id || "").trim();
  else name = String(spk || "").trim();
  if (!name) return "";

  // 1) 直接是 key
  if (speakers[name]) return name;
  // 2) 与某个发言人的名字匹配（不区分大小写）
  const lower = name.toLowerCase();
  const hit = Object.keys(speakers).find((id) => {
    const n = (speakers[id].name || "").toLowerCase();
    return n === lower || n === name;
  });
  if (hit) return hit;
  // 3) 未知名字：自动注册为新的发言人
  const newId = "sp" + (Object.keys(speakers).length + 1);
  speakers[newId] = { name, role: "", color: PALETTE[Object.keys(speakers).length % PALETTE.length] };
  return newId;
}

function normalizeConfig(cfg) {
  const out = {
    title: cfg.title || "会议回放",
    date: cfg.date || "",
    participants: cfg.participants || 0,
    duration: Number(cfg.duration) || 0,
    videoUrl: cfg.videoUrl || "",
    poster: cfg.poster || "",
    speakers: {},
    speakerOrder: [],
    chapters: [],
    segments: [],
  };

  // 发言人
  const spk = cfg.speakers || {};
  if (Array.isArray(spk)) {
    spk.forEach((s, i) => {
      const id = s.id || "sp" + (i + 1);
      out.speakers[id] = {
        name: s.name || "发言人",
        role: s.role || "",
        color: s.color || PALETTE[i % PALETTE.length],
      };
    });
  } else {
    Object.keys(spk).forEach((id, i) => {
      const s = spk[id];
      out.speakers[id] = {
        name: s.name || "发言人",
        role: s.role || "",
        color: s.color || PALETTE[i % PALETTE.length],
      };
    });
  }
  out.speakerOrder = Object.keys(out.speakers);

  // 章节
  out.chapters = (cfg.chapters || []).map((c) => ({ start: Number(c.start) || 0, title: c.title || "章节" }))
    .sort((a, b) => a.start - b.start);

  // 逐字稿（句子级）
  let segs = cfg.transcript || [];
  if (!Array.isArray(segs)) segs = [];
  segs = segs
    .map((s, i) => {
      const start = Number(s.start) || 0;
      const nextStart = segs[i + 1] ? Number(segs[i + 1].start) || 0 : start + 5;
      const end = s.end !== undefined ? Number(s.end) : Math.max(nextStart, start + 2);
      const rawText = String(s.text || "").trim();
      // 说话人字段支持多种常见命名
      let spkRaw = s.speaker ?? s.speakerId ?? s.speakerName ?? s.speaker_name ?? s.name ?? s.who ?? "";
      const spkFieldProvided = String(spkRaw).trim() !== "";
      // 若没有说话人字段，且文本以 "名字: 内容" 开头，则从文本提取说话人
      const nameMatch = rawText.match(/^([^:：]{1,20})[：:]\s*(.+)$/);
      if (!spkFieldProvided && nameMatch) {
        spkRaw = nameMatch[1];
      }
      const spkId = resolveSpeakerId(spkRaw, out.speakers);
      return {
        start,
        end: Math.max(end, start + 0.5),
        speaker: spkId,
        text: !spkFieldProvided && nameMatch ? nameMatch[2] : rawText,
      };
    })
    .filter((s) => s.text)
    .sort((a, b) => a.start - b.start);

  out.segments = segs;
  out.speakerOrder = Object.keys(out.speakers);
  const built = buildBlocks(segs);
  out.blocks = built.blocks;
  out.blockOfSeg = built.blockOfSeg;
  return out;
}

/* 同一个人连续说的话合并成一个块（类似 Teams） */
function buildBlocks(segs) {
  const blocks = [];
  const blockOfSeg = new Array(segs.length).fill(-1);
  segs.forEach((seg, i) => {
    const last = blocks[blocks.length - 1];
    // 同一位发言人连续发言合并为一块；说话人未知（空）时一律独立成块，避免整段糊成一大块
    const sameSpeaker = last && last.speaker === seg.speaker;
    const merge = sameSpeaker && seg.speaker !== "";
    if (last && merge) {
      last.end = seg.end;
      last.segIndexes.push(i);
      last.lines.push({ start: seg.start, end: seg.end, text: seg.text, segIndex: i });
      blockOfSeg[i] = blocks.length - 1;
    } else {
      blocks.push({
        start: seg.start,
        end: seg.end,
        speaker: seg.speaker,
        segIndexes: [i],
        lines: [{ start: seg.start, end: seg.end, text: seg.text, segIndex: i }],
      });
      blockOfSeg[i] = blocks.length - 1;
    }
  });
  return { blocks, blockOfSeg };
}

/* 合并 config.js 与默认值 */
function loadConfig() {
  const cfg = window.MEETING_CONFIG || {};
  const norm = normalizeConfig(cfg);
  state.title = norm.title;
  state.date = norm.date;
  state.participants = norm.participants;
  state.duration = norm.duration;
  state.videoUrl = norm.videoUrl;
  state.poster = norm.poster;
  state.speakers = norm.speakers;
  state.speakerOrder = norm.speakerOrder;
  state.chapters = norm.chapters;
  state.segments = norm.segments;
  state.blocks = norm.blocks;
  state.blockOfSeg = norm.blockOfSeg;
  state.activeIdx = -1;
}

/* ---------- 渲染 ---------- */
function speakerOf(id) {
  return state.speakers[id] || { name: "发言人", role: "", color: "#8a8886" };
}

function chapterIndexOf(time) {
  let ci = -1;
  for (let i = 0; i < state.chapters.length; i++) {
    if (time >= state.chapters[i].start - 0.01) ci = i;
  }
  return ci;
}

function highlightText(text) {
  const q = state.searchQuery.trim();
  if (!q) return esc(text);
  const re = new RegExp("(" + escapeRegex(esc(q)) + ")", "gi");
  return esc(text).replace(re, "<mark>$1</mark>");
}

function renderTranscript() {
  const blocks = state.blocks;
  if (!state.segments.length) {
    transcriptList.innerHTML = `<div class="t-empty">暂无 Transcript 数据<br>可拖入 JSON / VTT / SRT 文件，或在设置中导入</div>`;
    return;
  }

  let html = "";
  let lastChapter = -1;
  blocks.forEach((block, b) => {
    const ci = chapterIndexOf(block.start);
    if (ci >= 0 && ci !== lastChapter) {
      const ch = state.chapters[ci];
      html += `<div class="chapter-head"><span class="ch-badge">章节 ${ci + 1}</span><span class="ch-title">${esc(ch.title)}</span></div>`;
      lastChapter = ci;
    }
    const sp = speakerOf(block.speaker);
    const initial = (sp.name || "?").trim().charAt(0) || "?";
    const active = state.activeIdx >= 0 && block.segIndexes.includes(state.activeIdx) ? " active" : "";
    const lines = block.lines.map((line) => {
      const lineActive = line.segIndex === state.activeIdx ? " active" : "";
      return `<div class="t-line${lineActive}" data-start="${line.start}" data-end="${line.end}" data-seg="${line.segIndex}">
        <span class="t-line-time">${fmtClock(line.start)}</span>
        <span class="t-line-text">${highlightText(line.text)}</span>
      </div>`;
    }).join("");

    html += `
      <div class="t-item${active}" data-block="${b}">
        <div class="t-avatar" style="background:${esc(sp.color)}">${esc(initial)}</div>
        <div class="t-body">
          <div class="t-meta">
            <span class="t-name">${esc(sp.name)}</span>
            ${sp.role ? `<span class="t-role">${esc(sp.role)}</span>` : ""}
            <span class="t-time" data-start="${block.start}">${fmtClock(block.start)}</span>
          </div>
          <div class="t-text">${lines}</div>
        </div>
      </div>`;
  });
  transcriptList.innerHTML = html;
  updateTranscriptFooter();
}

function renderChapters() {
  if (!state.chapters.length) {
    chaptersBar.hidden = true;
    chaptersRow.innerHTML = "";
    return;
  }
  chaptersBar.hidden = false;
  chaptersRow.innerHTML = state.chapters
    .map((ch, i) => `<button class="chip" data-chapter="${i}"><span>${esc(ch.title)}</span><span class="chip-time">${fmtClock(ch.start)}</span></button>`)
    .join("");
}

function updateMeta() {
  $("#meetingTitle").textContent = state.title;
  const meta = [];
  if (state.date) meta.push(state.date);
  const dur = state.duration || (isFinite(video.duration) ? video.duration : 0);
  if (dur) meta.push(fmtClock(dur));
  if (state.participants) meta.push(`${state.participants} 位参与者`);
  $("#metaDate").textContent = meta[0] || "";
  $("#metaDuration").textContent = meta[1] || "";
  $("#metaParticipants").textContent = meta[2] || "";
}

function updateTranscriptFooter() {
  if (!state.segments.length) { $("#transcriptFooter").innerHTML = ""; return; }
  const lastEnd = state.segments[state.segments.length - 1].end;
  const min = Math.max(1, Math.round(lastEnd / 60));
  $("#transcriptFooter").innerHTML = `
    <span>共 ${state.blocks.length} 条发言 · ${state.segments.length} 句 · 约 ${min} 分钟</span>
    <span class="hint">空格 播放/暂停 · ←/→ 快退/快进</span>`;
}/* ---------- 播放器控制 ---------- */
function togglePlay() {
  if (!state.loadedVideo) return;
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function updatePlayUI() {
  const playing = !video.paused && !video.ended;
  $(".ico-play", $("#btnPlay")).hidden = playing;
  $(".ico-pause", $("#btnPlay")).hidden = !playing;
  $("#btnBigPlay svg path").setAttribute("d", playing ? "M6 19h4V5H6v14zm8-14v14h4V5h-4z" : "M8 5v14l11-7z");
  videoShell.classList.toggle("show-overlay", state.loadedVideo && video.paused);
  videoShell.classList.toggle("controls-pinned", video.paused);
}

function seekTo(t) {
  if (!state.loadedVideo || !isFinite(t)) return;
  video.currentTime = Math.max(0, Math.min(t, video.duration || 0));
}

function updateProgressUI() {
  const dur = isFinite(video.duration) ? video.duration : 0;
  if (!dur) {
    progressPlayed.style.width = "0%";
    progressThumb.style.left = "0%";
    return;
  }
  const pct = (video.currentTime / dur) * 100;
  progressPlayed.style.width = pct + "%";
  progressThumb.style.left = pct + "%";
  $("#timeCurrent").textContent = fmtClock(video.currentTime);
  $("#timeTotal").textContent = fmtClock(dur);
  progress.setAttribute("aria-valuemax", Math.round(dur));
  progress.setAttribute("aria-valuenow", Math.round(video.currentTime));
}

function updateBufferedUI() {
  const dur = video.duration;
  if (!dur || !video.buffered.length) { progressBuffered.style.width = "0%"; return; }
  const end = video.buffered.end(video.buffered.length - 1);
  progressBuffered.style.width = Math.min(100, (end / dur) * 100) + "%";
}

/* 进度条拖拽 */
let dragActive = false;
function progressFromEvent(e) {
  const rect = progress.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  return (x / rect.width) * (video.duration || 0);
}
progress.addEventListener("pointerdown", (e) => {
  if (!state.loadedVideo) return;
  dragActive = true;
  progress.classList.add("dragging");
  progress.setPointerCapture(e.pointerId);
  video.pause();
  seekTo(progressFromEvent(e));
});
progress.addEventListener("pointermove", (e) => {
  if (dragActive) seekTo(progressFromEvent(e));
});
progress.addEventListener("pointerup", (e) => {
  if (!dragActive) return;
  dragActive = false;
  progress.classList.remove("dragging");
  seekTo(progressFromEvent(e));
  video.play().catch(() => {});
});

/* 音量 */
function updateVolumeUI() {
  const muted = video.muted || video.volume === 0;
  $("#volume").value = muted ? 0 : video.volume;
  $(".ico-vol", $("#btnMute")).style.opacity = muted ? 0.55 : 1;
}
$("#volume").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  video.muted = false;
  video.volume = v;
});
$("#btnMute").addEventListener("click", () => {
  video.muted = !video.muted;
  updateVolumeUI();
});

/* 速度 */
function updateSpeedBtn() {
  const r = settings.rate;
  const label = r === 1 ? "1x" : r.toFixed(2).replace(/\.?0+$/, "") + "x";
  $("#btnSpeed").textContent = label;
  $$(".speed-menu button").forEach((b) => {
    b.classList.toggle("active", parseFloat(b.dataset.rate) === r);
  });
}
$("#btnSpeed").addEventListener("click", (e) => {
  e.stopPropagation();
  speedMenu.hidden = !speedMenu.hidden;
});
speedMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-rate]");
  if (!btn) return;
  settings.rate = parseFloat(btn.dataset.rate);
  video.playbackRate = settings.rate;
  saveSettings();
  updateSpeedBtn();
  speedMenu.hidden = true;
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".speed-wrap")) speedMenu.hidden = true;
});

/* 全屏 / 画中画 */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    videoShell.requestFullscreen?.().catch(() => {});
  }
}
$("#btnFullscreen").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("fullscreen-video", !!document.fullscreenElement);
});

$("#btnPip").addEventListener("click", async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (video.requestPictureInPicture) await video.requestPictureInPicture();
  } catch (e) { toast("当前浏览器不支持画中画"); }
});
if (!document.pictureInPictureEnabled) $("#btnPip").hidden = true;

/* ---------- 视频事件 ---------- */
let loadTimer = null;
function armLoadTimeout() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    if (state.loadedVideo && video.readyState < 1 && !video.error) {
      videoError.hidden = false;
      videoEmpty.hidden = true;
      const p = $("#videoError p");
      if (p) p.textContent = "⚠ 视频加载超时";
      $("#btnRetryVideo").textContent = "重试";
      toast("视频加载超时，可点击「生成示例视频」离线演示");
    }
  }, 8000);
}

video.addEventListener("loadedmetadata", () => {
  clearTimeout(loadTimer);
  if (!state.duration) state.duration = video.duration;
  updateMeta();
  updateProgressUI();
  updateBufferedUI();
});
video.addEventListener("durationchange", () => { updateProgressUI(); updateBufferedUI(); });
video.addEventListener("progress", updateBufferedUI);
video.addEventListener("timeupdate", () => {
  updateProgressUI();
  syncTranscript(video.currentTime);
});
video.addEventListener("play", () => {
  updatePlayUI();
  if (!state.duration) { state.duration = video.duration; updateMeta(); }
  rAF();
});
video.addEventListener("pause", updatePlayUI);
video.addEventListener("ended", () => { updatePlayUI(); syncTranscript(video.duration || 0); });
video.addEventListener("volumechange", updateVolumeUI);
video.addEventListener("error", () => {
  if (state.loadedVideo) {
    videoError.hidden = false;
    videoEmpty.hidden = true;
    toast("视频加载失败");
  }
});

let rafId = null;
function rAF() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    if (!video.paused && !video.ended) {
      updateProgressUI();
      rafId = requestAnimationFrame(loop);
    } else {
      updateProgressUI();
    }
  };
  rafId = requestAnimationFrame(loop);
}

/* ---------- Transcript 联动（块级高亮 + 句级高亮） ---------- */
function findActiveIndex(t) {
  const segs = state.segments;
  if (!segs.length) return -1;
  let lo = 0, hi = segs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans >= 0 && t <= segs[ans].end + 0.05) return ans;
  return ans;
}

function syncTranscript(t) {
  const idx = findActiveIndex(t);
  if (idx === state.activeIdx) return;
  state.activeIdx = idx;
  const blockIdx = idx >= 0 ? state.blockOfSeg[idx] : -1;

  // 块级高亮
  $$(".t-item", transcriptList).forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.block) === blockIdx);
  });
  // 句级高亮（块内当前句）
  $$(".t-line", transcriptList).forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.seg) === idx);
  });

  // 自动滚动到当前块
  if (blockIdx >= 0 && settings.autoScroll && !dragActive) {
    const el = $(`.t-item[data-block="${blockIdx}"]`, transcriptList);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // 章节高亮
  const ci = blockIdx >= 0 ? chapterIndexOf(state.blocks[blockIdx].start) : -1;
  $$(".chip", chaptersRow).forEach((c) => c.classList.toggle("active", Number(c.dataset.chapter) === ci));
}

/* 点击逐字稿跳转：优先定位到具体句子，否则定位到该发言人块开头 */
transcriptList.addEventListener("click", (e) => {
  const line = e.target.closest(".t-line");
  if (line) {
    const t = parseFloat(line.dataset.start);
    if (isFinite(t)) { seekTo(t); video.play().catch(() => {}); syncTranscript(t); }
    return;
  }
  const item = e.target.closest(".t-item");
  if (item) {
    const block = state.blocks[Number(item.dataset.block)];
    if (block) { seekTo(block.start); video.play().catch(() => {}); syncTranscript(block.start); }
  }
});

/* 章节跳转 */
chaptersRow.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const ch = state.chapters[Number(chip.dataset.chapter)];
  if (!ch) return;
  seekTo(ch.start);
  video.play().catch(() => {});
});

/* 点击视频切换播放 */
videoShell.addEventListener("click", (e) => {
  if (e.target.closest(".controls") || e.target.closest("#videoEmpty") || e.target.closest("#videoError")) return;
  if (e.target.closest("#btnBigPlay")) { togglePlay(); return; }
  if (state.loadedVideo) togglePlay();
});/* ---------- 搜索 ---------- */
function computeMatches() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) { state.matches = []; state.matchCursor = -1; return; }
  state.matches = [];
  state.segments.forEach((s, i) => {
    if (s.text.toLowerCase().includes(q) || speakerOf(s.speaker).name.toLowerCase().includes(q)) {
      state.matches.push(i);
    }
  });
  state.matchCursor = state.matches.length ? 0 : -1;
}

function updateSearchUI() {
  const hasQ = !!state.searchQuery.trim();
  const count = state.matches.length;
  $("#searchClear").hidden = !hasQ;
  $("#searchPrev").hidden = !(hasQ && count > 0);
  $("#searchNext").hidden = !(hasQ && count > 0);
  const cnt = $("#searchCount");
  if (hasQ) {
    cnt.hidden = false;
    cnt.textContent = count ? `${state.matchCursor + 1}/${count}` : "无匹配";
  } else {
    cnt.hidden = true;
    cnt.textContent = "";
  }
  if (!count) toast("没有找到匹配内容");
}

function jumpToMatch(dir) {
  if (!state.matches.length) return;
  state.matchCursor = (state.matchCursor + dir + state.matches.length) % state.matches.length;
  updateSearchUI();
  const idx = state.matches[state.matchCursor];
  const blockIdx = state.blockOfSeg[idx];
  const el = blockIdx >= 0 ? $(`.t-item[data-block="${blockIdx}"]`, transcriptList) : null;
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  seekTo(state.segments[idx].start);
}

$("#searchInput").addEventListener("input", (e) => {
  state.searchQuery = e.target.value;
  computeMatches();
  renderTranscript();
  updateSearchUI();
});
$("#searchClear").addEventListener("click", () => {
  $("#searchInput").value = "";
  state.searchQuery = "";
  computeMatches();
  renderTranscript();
  updateSearchUI();
  $("#searchInput").focus();
});
$("#searchNext").addEventListener("click", () => jumpToMatch(1));
$("#searchPrev").addEventListener("click", () => jumpToMatch(-1));
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); jumpToMatch(1); }
  if (e.key === "Escape") { $("#searchInput").value = ""; state.searchQuery = ""; computeMatches(); renderTranscript(); updateSearchUI(); }
});

/* ---------- 复制 Transcript（按句子输出，带时间戳与发言人） ---------- */
$("#btnCopy").addEventListener("click", async () => {
  const lines = state.segments.map((s) => `${fmtClock(s.start)}  ${speakerOf(s.speaker).name}: ${s.text}`);
  const text = `${state.title}\n${state.date}\n\n` + lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Transcript 已复制");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Transcript 已复制");
  }
});

/* ---------- 字号 / 自动滚动 ---------- */
$("#btnFontInc").addEventListener("click", () => {
  settings.fontSize = Math.min(18, settings.fontSize + 0.5);
  transcriptList.style.fontSize = settings.fontSize + "px";
  saveSettings();
});
$("#btnFontDec").addEventListener("click", () => {
  settings.fontSize = Math.max(12, settings.fontSize - 0.5);
  transcriptList.style.fontSize = settings.fontSize + "px";
  saveSettings();
});
$("#btnScrollLock").addEventListener("click", () => {
  settings.autoScroll = !settings.autoScroll;
  $("#cfgAutoScroll").checked = settings.autoScroll;
  $("#btnScrollLock").classList.toggle("on", settings.autoScroll);
  saveSettings();
  toast(settings.autoScroll ? "已开启自动跟随" : "已关闭自动跟随");
});

/* ---------- 文件导入 ---------- */
function openVideoFile(file) {
  if (!file || !file.type.startsWith("video/")) { toast("请选择视频文件"); return; }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  setVideoSource(state.objectUrl, file.name.replace(/\.[^.]+$/, ""), true);
}

function setVideoSource(src, title, isLocal) {
  video.src = src;
  video.poster = isLocal ? "" : state.poster;
  state.loadedVideo = true;
  videoEmpty.hidden = true;
  videoError.hidden = true;
  const errP = $("#videoError p");
  if (errP) errP.textContent = "⚠ 视频加载失败";
  $("#btnRetryVideo").textContent = "选择本地视频";
  if (title) { state.title = title; $("#videoTitleOverlay").textContent = title; }
  updateMeta();
  updatePlayUI();
  video.load();
  armLoadTimeout();
  video.play().catch(() => {});
}

$("#btnPickVideo").addEventListener("click", () => $("#fileVideo").click());
$("#btnRetryVideo").addEventListener("click", () => $("#fileVideo").click());
$("#btnOpen").addEventListener("click", () => $("#fileVideo").click());
$("#fileVideo").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) openVideoFile(f);
  e.target.value = "";
});

/* Transcript 文件解析 */
function parseTimestamp(str) {
  // 兼容 hh:mm:ss.mmm / mm:ss.mmm / hh:mm:ss,mmm
  const m = str.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4].padEnd(3, "0")) / 1000 : 0);
}

function parseVttLike(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const segs = [];
  let i = 0;
  while (i < lines.length) {
    const arrow = lines[i].indexOf("-->");
    if (arrow === -1) { i++; continue; }
    const start = parseTimestamp(lines[i].slice(0, arrow));
    const end = parseTimestamp(lines[i].slice(arrow + 3));
    i++;
    if (start === null || end === null) continue;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== "" && lines[i].indexOf("-->") === -1) {
      textLines.push(lines[i].trim());
      i++;
    }
    const raw = textLines.join(" ").replace(/\s+/g, " ").trim();
    if (raw) {
      let speaker = "";
      // 1) WebVTT 标准说话人标签：<v 张三> 或 <v.speaker1>
      const vMatch = raw.match(/<v\s*\.?([^>]*)>/);
      if (vMatch && vMatch[1].trim()) {
        speaker = vMatch[1].trim().replace(/^\.+/, "").trim();
      }
      // 2) 移除所有标签，保留纯文本
      let clean = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      // 3) 行首 "名字: 内容" 格式
      if (!speaker) {
        const nameMatch = clean.match(/^([^:：]{1,20})[：:]\s*(.+)$/);
        if (nameMatch) { speaker = nameMatch[1]; clean = nameMatch[2]; }
      }
      segs.push({ start, end: Math.max(end, start + 0.5), speaker, text: clean });
    }
  }
  return segs;
}

function parseJsonTranscript(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { transcript: data };
  if (data.transcript || data.segments) return data;
  return { transcript: [data] };
}

function parseTranscriptText(text, fileName) {
  const name = (fileName || "").toLowerCase();
  if (name.endsWith(".json")) return parseJsonTranscript(text);
  if (name.endsWith(".vtt") || name.endsWith(".srt") || name.endsWith(".txt")) return { transcript: parseVttLike(text) };
  try { return parseJsonTranscript(text); } catch (e) { return { transcript: parseVttLike(text) }; }
}

function importTranscriptFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result);
      const data = parseTranscriptText(text, file.name || "");
      applyTranscriptData(data);
      try {
        localStorage.setItem(IMPORT_KEY, JSON.stringify({ name: file.name || "transcript", text, time: Date.now() }));
      } catch (e) { /* ignore */ }
      toast(`已导入 ${state.segments.length} 句 / ${state.blocks.length} 条发言`);
    } catch (e) {
      toast("Transcript 解析失败，请检查文件格式");
    }
  };
  reader.readAsText(file);
}

function restoreImportedTranscript() {
  try {
    const raw = localStorage.getItem(IMPORT_KEY);
    if (!raw) { toast("没有找到上次导入的 Transcript"); return; }
    const stored = JSON.parse(raw);
    const data = parseTranscriptText(stored.text, stored.name || "");
    applyTranscriptData(data);
    toast(`已恢复上次导入（${state.segments.length} 句 / ${state.blocks.length} 条发言）`);
  } catch (e) {
    toast("恢复失败");
  }
}

function applyTranscriptData(data) {
  const norm = normalizeConfig({
    speakers: data.speakers || state.speakers,
    chapters: data.chapters || state.chapters,
    transcript: data.transcript || data.segments || [],
  });
  state.segments = norm.segments;
  state.blocks = norm.blocks;
  state.blockOfSeg = norm.blockOfSeg;
  state.chapters = norm.chapters;
  state.speakers = norm.speakers;
  state.speakerOrder = norm.speakerOrder;
  state.activeIdx = -1;
  computeMatches();
  renderTranscript();
  renderChapters();
  if (state.loadedVideo) syncTranscript(video.currentTime);
}

$("#btnPickTranscript").addEventListener("click", () => $("#fileTranscript").click());
$("#fileTranscript").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) importTranscriptFile(f);
  e.target.value = "";
});

/* 拖放 */
["dragenter", "dragover"].forEach((ev) =>
  videoShell.addEventListener(ev, (e) => { e.preventDefault(); videoShell.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  videoShell.addEventListener(ev, (e) => { e.preventDefault(); videoShell.classList.remove("dragover"); })
);
videoShell.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (file.type.startsWith("video/")) openVideoFile(file);
  else if (/\.(json|vtt|srt|txt)$/i.test(file.name)) importTranscriptFile(file);
  else toast("不支持的文件类型（支持视频 / JSON / VTT / SRT）");
});/* ---------- 键盘快捷键 ---------- */
document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) {
    if (e.key === "Escape" && tag === "INPUT") $("#searchInput").blur();
    return;
  }
  if (!$("#settingsModal").hidden && e.key === "Escape") { closeSettings(); return; }
  switch (e.key.toLowerCase()) {
    case " ": case "k": e.preventDefault(); togglePlay(); break;
    case "arrowleft": e.preventDefault(); seekTo(video.currentTime - (e.shiftKey ? 10 : 5)); break;
    case "arrowright": e.preventDefault(); seekTo(video.currentTime + (e.shiftKey ? 10 : 5)); break;
    case "arrowup": e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); break;
    case "arrowdown": e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); break;
    case "m": video.muted = !video.muted; updateVolumeUI(); break;
    case "f": toggleFullscreen(); break;
    case "t": $("#btnScrollLock").click(); break;
    case "home": seekTo(0); break;
    case "end": seekTo(video.duration || 0); break;
  }
});

/* ---------- 设置弹窗 ---------- */
function openSettings() {
  $("#settingsModal").hidden = false;
  $("#cfgVideoUrl").value = state.videoUrl;
}
function closeSettings() { $("#settingsModal").hidden = true; }
$("#btnSettings").addEventListener("click", openSettings);
$("#btnCloseSettings").addEventListener("click", closeSettings);
$("#settingsModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSettings(); });

$("#btnApplyVideo").addEventListener("click", () => {
  const url = $("#cfgVideoUrl").value.trim();
  if (!url) { toast("请输入视频地址"); return; }
  state.videoUrl = url;
  setVideoSource(url, state.title, false);
  toast("正在加载视频…");
  closeSettings();
});
$("#cfgPickVideo").addEventListener("click", () => $("#fileVideo").click());
$("#cfgPickTranscript").addEventListener("click", () => $("#fileTranscript").click());
$("#cfgLoadSample").addEventListener("click", () => {
  location.reload();
});
$("#cfgRestoreImport").addEventListener("click", restoreImportedTranscript);

$("#cfgAutoScroll").addEventListener("change", (e) => {
  settings.autoScroll = e.target.checked;
  $("#btnScrollLock").classList.toggle("on", settings.autoScroll);
  saveSettings();
});
$("#cfgDarkTheme").addEventListener("change", (e) => {
  settings.theme = e.target.checked ? "dark" : "light";
  saveSettings();
  applySettings();
});

/* ---------- 生成示例视频（离线演示用，Canvas + MediaRecorder） ---------- */
async function generateSampleVideo() {
  if (typeof window.MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) {
    toast("当前浏览器不支持生成示例视频，请选择本地视频文件");
    return;
  }
  toast("正在生成示例视频（约 8 秒）…");
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext("2d");
  const fps = 24, total = 8, frames = total * fps;
  const draw = (f) => {
    const t = f / fps;
    const grad = ctx.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, "#3a3f8f"); grad.addColorStop(1, "#6264a7");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 640, 360);
    ctx.strokeStyle = "rgba(255,255,255,.10)"; ctx.lineWidth = 1;
    for (let x = 0; x <= 640; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 360); ctx.stroke(); }
    for (let y = 0; y <= 360; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(640, y); ctx.stroke(); }
    const avatars = [[120, 120, "#E3008C", "林"], [290, 260, "#0078D4", "王"], [460, 110, "#107C10", "陈"], [530, 280, "#CA5010", "刘"]];
    avatars.forEach((a, i) => {
      const cx = a[0] + 14 * Math.sin(t * 1.4 + i * 1.7);
      const cy = a[1] + 10 * Math.cos(t * 1.1 + i * 1.2);
      ctx.fillStyle = a[2];
      ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 20px 'Segoe UI','Microsoft YaHei'"; ctx.textAlign = "center";
      ctx.fillText(a[3], cx, cy + 7);
      ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.font = "bold 32px 'Segoe UI','Microsoft YaHei'";
    ctx.fillText("产品迭代周会 · 回放演示", 320, 60);
    ctx.font = "15px 'Segoe UI','Microsoft YaHei'";
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillText("本地示例视频（Canvas 自动生成，可拖入真实录像替换）", 320, 84);
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(Math.floor(t % 60)).padStart(2, "0");
    ctx.font = "bold 22px Consolas,monospace";
    ctx.fillStyle = "#ffd166";
    ctx.fillText(`${mm}:${ss}`, 320, 300);
    const p = Math.min(1, t / total);
    ctx.fillStyle = "rgba(255,255,255,.25)";
    ctx.fillRect(20, 328, 600, 8);
    ctx.fillStyle = "#ffd166";
    ctx.fillRect(20, 328, 600 * p, 8);
  };
  const stream = canvas.captureStream(fps);
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 600000 });
  } catch (e) {
    rec = new MediaRecorder(stream);
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => (rec.onstop = res));
  rec.start(100);
  toast("生成示例视频：录制中…");
  let f = 0;
  await new Promise((res) => {
    const iv = setInterval(() => {
      draw(f++);
      if (f >= frames) { clearInterval(iv); rec.stop(); stream.getTracks().forEach((tr) => tr.stop()); }
    }, 1000 / fps);
  });
  toast("生成示例视频：合成文件中…");
  const stopDone = await Promise.race([
    stopped.then(() => true),
    new Promise((res) => setTimeout(() => res(false), 20000)),
  ]);
  if (!stopDone) { toast("生成示例视频超时，请重试"); try { rec.stop(); } catch (e) {} return; }
  const blob = new Blob(chunks, { type: "video/webm" });
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(blob);
  setVideoSource(state.objectUrl, "示例会议 · 自动生成", true);
  toast("示例视频已生成，开始播放");
}

/* ---------- 初始化 ---------- */
function init() {
  loadSettings();
  loadConfig();
  applySettings();
  renderTranscript();
  renderChapters();
  updateMeta();
  updatePlayUI();

  // 加载视频
  if (state.videoUrl) {
    setVideoSource(state.videoUrl, state.title, false);
  } else {
    state.loadedVideo = false;
    videoEmpty.hidden = false;
    videoOverlay.classList.remove("has-video");
  }
}

$("#btnBack").addEventListener("click", () => toast("返回主页（示例）"));
$("#btnLoadSample").addEventListener("click", generateSampleVideo);
$("#cfgGenSample").addEventListener("click", generateSampleVideo);
$("#btnGenError").addEventListener("click", generateSampleVideo);

init();