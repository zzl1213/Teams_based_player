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

/* 带 0.1 秒精度的时间显示（用于 A/B 微调） */
function fmtClockP(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const d = Math.floor(t * 10) / 10;
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  const s = d % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(Math.floor(s)).padStart(2, "0");
  const ds = String(Math.round((s % 1) * 10));
  return (h > 0 ? `${h}:${mm}:${ss}.${ds}` : `${mm}:${ss}.${ds}`);
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
  ab: { a: null, b: null, count: 3, remaining: 0, active: false, label: "" },
  sel: null, // Transcript 中选中的内容 { startSeg, endSeg, startOff, endOff, text, lines }
};

const settings = {
  autoScroll: true,
  theme: "light",
  rate: 1,
  fontSize: 13.5,
  repeatCount: 3,
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

/* 提取句子中的逐词时间戳（支持多种字段命名），用于精确复读单词 */
function extractWords(s) {
  let arr = s.words || s.wordTimings || s.word_timings || s.wordTimes || s.word_times || null;
  if (!arr && Array.isArray(s.tokens)) arr = s.tokens;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const w of arr) {
    const text = String(w.word ?? w.text ?? w.token ?? w.w ?? "").trim();
    const ws = Number(w.start ?? w.startTime ?? w.start_time ?? w.from ?? w.s ?? w.t0);
    const we = Number(w.end ?? w.endTime ?? w.end_time ?? w.to ?? w.e ?? w.t1);
    if (text && Number.isFinite(ws) && Number.isFinite(we) && we > ws) {
      out.push({ w: text, s: ws, e: we });
    }
  }
  return out.sort((x, y) => x.s - y.s);
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
        words: extractWords(s),
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
  clearSelection(true);
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
        <button class="t-repeat" title="复读本句（选中句中文字可复读单词）" aria-label="复读本句">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" fill="currentColor"/></svg>
        </button>
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
  if (state.ab.active) stopABLoop();
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
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
function stepSpeed(dir) {
  let idx = SPEED_PRESETS.indexOf(settings.rate);
  if (idx < 0) idx = SPEED_PRESETS.indexOf(1);
  idx = (idx + dir + SPEED_PRESETS.length) % SPEED_PRESETS.length;
  settings.rate = SPEED_PRESETS[idx];
  video.playbackRate = settings.rate;
  saveSettings();
  updateSpeedBtn();
}
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
  // 循环边界检测挂在媒体时钟事件上：页面在后台（rAF 暂停）时仍会触发
  if (state.ab.active) checkAB(video.currentTime);
  syncTranscript(video.currentTime);
});
video.addEventListener("play", () => {
  updatePlayUI();
  if (!state.duration) { state.duration = video.duration; updateMeta(); }
  rAF();
});
video.addEventListener("pause", updatePlayUI);
video.addEventListener("ended", () => {
  if (state.ab.active && state.ab.b !== null && state.ab.b >= (video.duration || 0) - 0.1) {
    // AB 终点恰在视频末尾：按到达 B 处理（计数/跳回/结束都由 checkAB 决定）
    checkAB(video.duration || state.ab.b);
    if (state.ab.active) video.play().catch(() => {});
    return;
  }
  updatePlayUI(); syncTranscript(video.duration || 0);
});
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
      if (state.ab.active) checkAB(video.currentTime);
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



}

/* 点击逐字稿跳转：优先定位到具体句子，否则定位到该发言人块开头 */
/* 区分“拖选文字”与“点击跳转”：拖动超过 4px 视为在选词/选句 */
let dragMoved = false;
let downX = 0, downY = 0;
transcriptList.addEventListener("mousedown", (e) => {
  dragMoved = false;
  downX = e.clientX; downY = e.clientY;
});
document.addEventListener("mousemove", (e) => {
  if ((e.buttons & 1) && !dragMoved) {
    if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) dragMoved = true;
  }
});

transcriptList.addEventListener("click", (e) => {
  const repeatBtn = e.target.closest(".t-repeat");
  if (repeatBtn) { repeatFromLine(repeatBtn.closest(".t-line")); return; }
  // 拖选或双击/三击形成文字选区后的 click：保留选区，不当作“点击跳转”
  if (e.detail >= 2 || dragMoved) {
    dragMoved = false;
    return;
  }
  const line = e.target.closest(".t-line");
  if (line) {
    const t = parseFloat(line.dataset.start);
    if (isFinite(t)) {
      if (state.ab.active) stopABLoop();
      clearSelection();
      seekTo(t); video.play().catch(() => {}); syncTranscript(t);
    }
    return;
  }
  const item = e.target.closest(".t-item");
  if (item) {
    const block = state.blocks[Number(item.dataset.block)];
    if (block) {
      if (state.ab.active) stopABLoop();
      seekTo(block.start); video.play().catch(() => {}); syncTranscript(block.start);
    }
  }
});

/* ---------- Transcript 选区复读（连续多句 / 单个单词） ---------- */
function closestTranscriptLine(node) {
  while (node && node !== transcriptList && node !== document.body) {
    if (node.nodeType === 1 && node.classList && node.classList.contains("t-line")) return node;
    node = node.parentElement || node.parentNode;
  }
  return null;
}

function updateSelectBar(sel) {
  const bar = $("#selBar");
  if (!sel || !sel.text) { bar.hidden = true; return; }
  $("#selInfo").textContent = sel.lines > 1
    ? `已选中 ${sel.lines} 句连续发言`
    : `已选中：「${sel.text.trim().slice(0, 18)}」`;
  bar.hidden = false;
}

function clearSelection(silent) {
  state.sel = null;
  const bar = $("#selBar");
  if (bar) bar.hidden = true;
  if (!silent) {
    try {
      const s = window.getSelection();
      if (s) s.removeAllRanges();
    } catch (e) { /* ignore */ }
  }
}

/* 用当前选中内容设置 AB 区间并开始复读 */
function repeatFromSelection() {
  const sel = state.sel;
  if (!sel) { toast("请先在 Transcript 中选中内容"); return; }
  const first = state.segments[sel.startSeg];
  const last = state.segments[sel.endSeg];
  if (!first || !last) return;
  let a = first.start, b = last.end;
  let label = sel.text.trim().slice(0, 24);
  // 单句内选中的单词 / 句子局部
  if (sel.startSeg === sel.endSeg && sel.startOff !== null && sel.endOff !== null && sel.endOff > sel.startOff) {
    const fullText = first.text;
    label = fullText.slice(sel.startOff, sel.endOff).trim().slice(0, 24);
    // 1) 若该句带逐词时间戳：直接精确对齐
    if (first.words && first.words.length) {
      const ranges = [];
      let pos = 0;
      for (const w of first.words) {
        const idx = fullText.indexOf(w.w, pos);
        const ws = idx >= 0 ? idx : pos;
        const we = ws + w.w.length;
        ranges.push({ ws, we, w });
        pos = we;
      }
      const hit = ranges.filter((r) => r.we > sel.startOff && r.ws < sel.endOff);
      if (hit.length) {
        a = Math.max(first.start, hit[0].w.s - 0.03);
        b = Math.min(first.end, hit[hit.length - 1].w.e + 0.12);
        state.ab.a = a;
        state.ab.b = Math.max(b, a + 0.2);
        clearSelection();
        startABLoop(label);
        return;
      }
    }
    // 2) 无逐词时间戳：按比例估算（中文按字符；英文按单词长度加权）
    const dur = first.end - first.start;
    const hasCJK = /[\u4e00-\u9fff]/.test(fullText);
    let rs, re;
    if (hasCJK) {
      rs = Math.min(1, sel.startOff / fullText.length);
      re = Math.min(1, sel.endOff / fullText.length);
    } else {
      const bounds = [];
      const wRe = /\S+/g; let m;
      while ((m = wRe.exec(fullText)) !== null) bounds.push({ s: m.index, e: m.index + m[0].length });
      const totalW = bounds.reduce((acc, b) => acc + (b.e - b.s), 0) || 1;
      const weightBefore = (off) => {
        let acc = 0;
        for (const b of bounds) {
          if (b.e <= off) acc += b.e - b.s;
          else if (b.s < off) acc += off - b.s;
          else break;
        }
        return acc;
      };
      rs = Math.min(1, weightBefore(sel.startOff) / totalW);
      re = Math.min(1, weightBefore(sel.endOff) / totalW);
    }
    let wa = first.start + rs * dur;
    let wb = first.start + re * dur;
    // 短单词保底时长，末尾留尾巴避免最后一词被掐断
    const minDur = 0.6;
    if (wb - wa < minDur) {
      const mid = (wa + wb) / 2;
      wa = mid - minDur / 2;
      wb = mid + minDur / 2;
    }
    a = Math.max(first.start, wa - 0.05);
    b = Math.min(first.end, wb + 0.12);
  }
  state.ab.a = a;
  state.ab.b = Math.max(b, a + 0.2);
  clearSelection();
  startABLoop(label);
}

/* 记录 Transcript 中的文字选区（拖选多句或单词时触发，含键盘选区） */
function captureTranscriptSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const startLine = closestTranscriptLine(range.startContainer);
  const endLine = closestTranscriptLine(range.endContainer);
  if (!startLine || !endLine) return;
  const allLines = $$(".t-line", transcriptList);
  const i0 = allLines.indexOf(startLine);
  const i1 = allLines.indexOf(endLine);
  if (i0 < 0 || i1 < 0 || i0 > i1) return;
  const selLines = allLines.slice(i0, i1 + 1);
  const startSeg = Number(selLines[0].dataset.seg);
  const endSeg = Number(selLines[selLines.length - 1].dataset.seg);
  // 必须是连续句子
  if (endSeg - startSeg + 1 !== selLines.length) return;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (!text) return;
  let startOff = null, endOff = null;
  if (selLines.length === 1) {
    const textEl = selLines[0].querySelector(".t-line-text");
    if (textEl) {
      const pre = range.cloneRange();
      pre.selectNodeContents(textEl);
      pre.setEnd(range.startContainer, range.startOffset);
      startOff = pre.toString().length;
      endOff = startOff + range.toString().length;
    }
  }
  state.sel = { startSeg, endSeg, startOff, endOff, text, lines: selLines.length };
  updateSelectBar(state.sel);
}

document.addEventListener("selectionchange", captureTranscriptSelection);

/* 点击 Transcript 面板以外的区域时清除选区 */
document.addEventListener("mousedown", (e) => {
  if (state.sel && !e.target.closest(".transcript-panel")) clearSelection();
});

$("#btnRepeatSel").addEventListener("click", repeatFromSelection);
$("#btnClearSel").addEventListener("click", () => clearSelection());


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
    case "arrowleft": e.preventDefault(); if (state.ab.active) stopABLoop(); seekTo(video.currentTime - (e.shiftKey ? 10 : 5)); break;
    case "arrowright": e.preventDefault(); if (state.ab.active) stopABLoop(); seekTo(video.currentTime + (e.shiftKey ? 10 : 5)); break;
    case "arrowup": e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); break;
    case "arrowdown": e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); break;
    case "]": case ">": e.preventDefault(); stepSpeed(1); break;
    case "[": case "<": e.preventDefault(); stepSpeed(-1); break;
    case "m": video.muted = !video.muted; updateVolumeUI(); break;
    case "f": toggleFullscreen(); break;
    case "t": $("#btnScrollLock").click(); break;
    case "home": if (state.ab.active) stopABLoop(); seekTo(0); break;
    case "end": if (state.ab.active) stopABLoop(); seekTo(video.duration || 0); break;
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

/* ---------- AB 复读（复读机） ---------- */
function abCanStart() {
  return state.ab.a !== null && state.ab.b !== null && state.ab.b > state.ab.a;
}

function updateABUI() {
  const abx = state.ab;
  $("#abTimeA").textContent = abx.a === null ? "--:--" : fmtClockP(abx.a);
  $("#abTimeB").textContent = abx.b === null ? "--:--" : fmtClockP(abx.b);
  $("#abTimeA").classList.toggle("active", abx.a !== null);
  $("#abTimeB").classList.toggle("active", abx.b !== null);
  const can = abCanStart();
  $("#btnAbToggle").disabled = !can;
  $("#btnAbClear").disabled = abx.a === null && abx.b === null;
  $("#btnAbToggle").classList.toggle("active", abx.active);
  $("#btnNudgeAM").disabled = abx.a === null;
  $("#btnNudgeAP").disabled = abx.a === null;
  $("#btnNudgeBM").disabled = abx.b === null;
  $("#btnNudgeBP").disabled = abx.b === null;
  $("#btnAbToggle").textContent = abx.active ? "■ 停止" : "▶ 复读";
  let status = "";
  if (abx.active) {
    const label = abx.label ? `「${abx.label}」` : "";
    status = abx.remaining === 0
      ? `${label} 无限循环中`
      : `${label} 第 ${abx.count - abx.remaining + 1}/${abx.count} 次`;
  } else if (can) {
    status = `${fmtClockP(abx.a)} → ${fmtClockP(abx.b)}（时长 ${fmtClockP(abx.b - abx.a)}）`;
  }
  $("#abStatus").textContent = status;
  // 高亮 Transcript 中与 AB 区间相交的句子
  $$(".t-line").forEach((el) => {
    const st = parseFloat(el.dataset.start), en = parseFloat(el.dataset.end);
    const hit = abx.a !== null && abx.b !== null && st <= abx.b && en >= abx.a;
    el.classList.toggle("ab-range", hit);
  });
}

function setPointA() {
  if (!state.loadedVideo) return;
  state.ab.a = video.currentTime;
  if (state.ab.b !== null && state.ab.b <= state.ab.a) state.ab.b = null;
  state.ab.active = false; state.ab.remaining = 0; state.ab.label = "";
  updateABUI();
  toast("已设置起点 A：" + fmtClock(state.ab.a));
}

function setPointB() {
  if (!state.loadedVideo) return;
  const t = video.currentTime;
  if (state.ab.a !== null && t <= state.ab.a) { toast("终点 B 必须晚于起点 A"); return; }
  state.ab.b = t;
  state.ab.active = false; state.ab.remaining = 0; state.ab.label = "";
  updateABUI();
  if (abCanStart()) toast(`已设置终点 B：${fmtClock(state.ab.b)}，点击「复读」开始`);
}

function clearAB() {
  stopABTick();
  Object.assign(state.ab, { a: null, b: null, active: false, remaining: 0, label: "" });
  updateABUI();
}

/* 后台标签页兜底：rAF 在页面隐藏时会被浏览器暂停，
   用独立定时器 + 媒体 timeupdate 双保险，保证循环在后台也生效 */
let abTick = null;
function startABTick() {
  stopABTick();
  abTick = setInterval(() => {
    if (state.ab.active && !video.paused && !video.ended) checkAB(video.currentTime);
  }, 200);
}
function stopABTick() {
  if (abTick) { clearInterval(abTick); abTick = null; }
}

function startABLoop(label) {
  if (!abCanStart()) { toast("请先设置 A / B 区间"); return; }
  const dur = isFinite(video.duration) ? video.duration : Infinity;
  if (state.ab.b > dur) state.ab.b = dur;
  state.ab.count = settings.repeatCount;
  state.ab.remaining = settings.repeatCount; // 0 = 无限
  state.ab.active = true;
  state.ab.label = label || "";
  startABTick();
  seekTo(state.ab.a);
  video.play().catch(() => {});
  updateABUI();
  const n = settings.repeatCount;
  toast(`开始复读${state.ab.label ? "「" + state.ab.label + "」" : ""}（${n === 0 ? "无限循环" : n + " 次"}）`);
}

function stopABLoop() {
  state.ab.active = false; state.ab.remaining = 0; state.ab.label = "";
  stopABTick();
  updateABUI();
}

function toggleAB() {
  if (state.ab.active) stopABLoop();
  else startABLoop();
}

/* 微调 AB 区间（±0.1 秒，Shift=±0.5 秒） */
function nudgeAB(which, delta) {
  const abx = state.ab;
  if (which === "a") {
    if (abx.a === null) return;
    abx.a = Math.max(0, abx.a + delta);
    if (abx.b !== null && abx.b <= abx.a) abx.b = abx.a + 0.1;
  } else {
    if (abx.b === null) return;
    const minB = abx.a === null ? 0 : abx.a + 0.1;
    abx.b = Math.max(minB, abx.b + delta);
    if (isFinite(video.duration)) abx.b = Math.min(video.duration, abx.b);
  }
  if (abx.active) seekTo(abx.a);
  updateABUI();
}

function checkAB(t) {
  const abx = state.ab;
  if (!abx.active || abx.a === null || abx.b === null) return;
  if (t >= abx.b) {
    if (abx.remaining === 0) { seekTo(abx.a); return; }
    abx.remaining--;
    if (abx.remaining > 0) {
      seekTo(abx.a);
      updateABUI();
    } else {
      abx.active = false;
      stopABTick();
      video.pause();
      updateABUI();
      toast("复读完成");
    }
  } else if (t < abx.a - 0.15) {
    seekTo(abx.a);
  }
}

/* 从 Transcript 句子设置 AB 区间并开始复读（若当前选中包含本句，则复读选中内容） */
function repeatFromLine(lineEl) {
  const segIdx = Number(lineEl.dataset.seg);
  const seg = state.segments[segIdx];
  if (!seg) return;
  if (state.sel && state.sel.startSeg <= segIdx && segIdx <= state.sel.endSeg) {
    repeatFromSelection();
    return;
  }
  state.ab.a = seg.start;
  state.ab.b = Math.max(seg.end, seg.start + 0.2);
  startABLoop((seg.text || "").trim().slice(0, 20));
}

$("#btnSetA").addEventListener("click", setPointA);
$("#btnSetB").addEventListener("click", setPointB);
$("#btnAbToggle").addEventListener("click", toggleAB);
$("#btnAbClear").addEventListener("click", clearAB);
$("#btnNudgeAM").addEventListener("click", (e) => nudgeAB("a", e.shiftKey ? -0.5 : -0.1));
$("#btnNudgeAP").addEventListener("click", (e) => nudgeAB("a", e.shiftKey ? 0.5 : 0.1));
$("#btnNudgeBM").addEventListener("click", (e) => nudgeAB("b", e.shiftKey ? -0.5 : -0.1));
$("#btnNudgeBP").addEventListener("click", (e) => nudgeAB("b", e.shiftKey ? 0.5 : 0.1));
function setRepeatCount(v) {
  settings.repeatCount = v;
  const abSel = $("#abCount");
  const selSel = $("#selCount");
  if (abSel) abSel.value = String(v);
  if (selSel) selSel.value = String(v);
  saveSettings();
}
$("#abCount").addEventListener("change", (e) => setRepeatCount(parseInt(e.target.value, 10)));
$("#selCount").addEventListener("change", (e) => setRepeatCount(parseInt(e.target.value, 10)));
/* ---------- 初始化 ---------- */
function init() {
  loadSettings();
  loadConfig();
  applySettings();
  renderTranscript();
  updateMeta();
  updatePlayUI();
  $("#abCount").value = String(settings.repeatCount);
  $("#selCount").value = String(settings.repeatCount);
  updateABUI();

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