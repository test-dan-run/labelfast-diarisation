'use strict';

const $ = (selector) => document.querySelector(selector);

const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#bab0ac'];
const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const RULER_H = 20, WAVE_H = 88, LANE_H = 26; // timeline geometry, px
const EDGE = 5;        // px within which a segment edge can be grabbed
const MIN_LEN = 0.05;  // shortest allowed segment, seconds
const NEW_LEN = 2;     // length of a segment created with N, seconds

const els = {
  home: $('#home'), editor: $('#editor'), form: $('#new'), create: $('#create'), projects: $('#projects'),
  name: $('#name'), status: $('#status'), timeline: $('#timeline'), lanes: $('#lanes'), stage: $('#stage'),
  minimap: $('#minimap'), thumb: $('#thumb'), play: $('#play'), clock: $('#clock'), rate: $('#rate'),
  autoplay: $('#autoplay'), count: $('#count'), relabel: $('#relabel'), list: $('#list'), help: $('#help'), menu: $('#menu'), toast: $('#toast'),
};
const audio = $('#audio');
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

const state = {
  project: null,
  segments: [],   // sorted by start time
  speakers: [],   // lane order
  selected: null, // segment id
  peaks: null,    // Int8Array of (min, max) pairs
  gain: 1,        // px per peak unit
  pps: 100,       // zoom: px per second
  left: 0,        // time at the left edge of the timeline
  playSeg: null,  // id of the segment playback stops at the end of
  undo: [],
  redo: [],
  dirty: false,
};
const view = { w: 0, h: 0 };
const theme = {};

// Helpers -----------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
const uid = () => Math.random().toString(36).slice(2, 10);
const natural = new Intl.Collator(undefined, { numeric: true }).compare;
const color = (lane) => PALETTE[(lane < 0 ? PALETTE.length - 1 : lane) % PALETTE.length];
const duration = () => state.project.duration;
const t2x = (t) => (t - state.left) * state.pps;
const x2t = (x) => state.left + x / state.pps;
const seg = (id) => state.segments.find((s) => s.id === id);
const selIndex = () => state.segments.findIndex((s) => s.id === state.selected);
const rowOf = (id) => (id ? els.list.querySelector(`[data-id="${id}"]`) : null);
const inTextField = () => document.activeElement?.tagName === 'TEXTAREA';
const countLabel = (n) => `${n} segment${n === 1 ? '' : 's'}`;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el[key] = value;
  }
  el.append(...children);
  return el;
}

function fmt(t, decimals = 2) {
  const scale = 10 ** decimals;
  t = Math.round(t * scale) / scale;
  const hours = Math.floor(t / 3600), mins = Math.floor((t % 3600) / 60);
  const secs = (t % 60).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0');
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
}

async function api(path, options) {
  const res = await fetch('/api' + path, options);
  if (!res.ok) {
    const detail = await res.json().then((body) => body.detail, () => null);
    throw new Error(typeof detail === 'string' ? detail : res.statusText || 'Request failed');
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2500 + message.length * 40);
}

// Home --------------------------------------------------------------------

const picked = { audio: null, labels: null };
const isLabelFile = (file) => /\.(rttm|json|jsonl)$/i.test(file.name);

function renderSlots() {
  const set = (slot, file, hint) => {
    slot.classList.toggle('filled', !!file);
    slot.querySelector('.slot-value').textContent = file ? file.name : hint;
  };
  set($('#slot-audio'), picked.audio, 'Drop a file here, or click to choose');
  set($('#slot-labels'), picked.labels, '.rttm or NeMo .json — leave empty to start from scratch');
  $('#clear-labels').hidden = !picked.labels;
  els.create.disabled = !picked.audio;
}

$('#in-audio').addEventListener('change', (e) => {
  picked.audio = e.target.files[0] || picked.audio;
  renderSlots();
});
$('#in-labels').addEventListener('change', (e) => {
  picked.labels = e.target.files[0] || picked.labels;
  renderSlots();
});
$('#clear-labels').addEventListener('click', (e) => {
  e.preventDefault();
  picked.labels = null;
  $('#in-labels').value = '';
  renderSlots();
});

function upload(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(xhr.response) : reject(new Error(xhr.response?.detail || 'Upload failed')));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(form);
  });
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!picked.audio) return;
  const form = new FormData();
  form.append('audio', picked.audio);
  if (picked.labels) form.append('labels', picked.labels);
  els.create.disabled = true;
  try {
    const project = await upload(form, (done) => {
      els.create.textContent = done < 1 ? `Uploading ${Math.round(done * 100)}%` : 'Preparing audio…';
    });
    picked.audio = picked.labels = null;
    $('#in-audio').value = $('#in-labels').value = '';
    location.hash = `#/p/${project.id}`;
  } catch (err) {
    toast(err.message);
  }
  els.create.textContent = 'Start annotating';
  renderSlots();
});

async function showHome() {
  els.editor.hidden = true;
  els.home.hidden = false;
  document.title = 'labelfast';
  renderSlots();
  const projects = await api('/projects');
  els.projects.replaceChildren(...projects.map((p) =>
    h('div', { className: 'project' },
      h('a', { href: `#/p/${p.id}` }, p.name),
      h('span', { className: 'muted' }, `${fmt(p.duration, 0)} · ${countLabel(p.segments)} · ${new Date(p.updated * 1000).toLocaleDateString()}`),
      h('button', {
        className: 'plain', title: 'Delete project',
        onclick: async () => {
          if (!confirm(`Delete "${p.name}" and its annotations?`)) return;
          await api(`/projects/${p.id}`, { method: 'DELETE' });
          showHome();
        },
      }, '×'))));
}

// Dropping files: audio and labels on the home page, labels in the editor.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.form.classList.add('over');
});
window.addEventListener('dragleave', () => els.form.classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  els.form.classList.remove('over');
  const files = [...e.dataTransfer.files];
  if (state.project) {
    const labels = files.find(isLabelFile);
    if (labels) importLabels(labels);
    return;
  }
  for (const file of files) picked[isLabelFile(file) ? 'labels' : 'audio'] = file;
  renderSlots();
});

// Project loading and saving ----------------------------------------------

function speakersOf(segments) {
  return [...new Set(segments.map((s) => s.speaker))].sort(natural);
}

async function openProject(id) {
  const [data, peaks] = await Promise.all([
    api(`/projects/${id}`),
    fetch(`/api/projects/${id}/peaks`).then((res) => res.arrayBuffer()),
  ]);
  Object.assign(state, {
    project: data.project, segments: data.segments, speakers: speakersOf(data.segments),
    selected: null, peaks: new Int8Array(peaks), playSeg: null, undo: [], redo: [], dirty: false, left: 0,
  });
  const loudest = state.peaks.reduce((max, v) => Math.max(max, Math.abs(v)), 1);
  state.gain = (WAVE_H / 2 - 3) / loudest;

  audio.src = `/api/projects/${id}/audio`;
  setRate();
  els.name.textContent = document.title = data.project.name;
  els.list.style.setProperty('--time-w', `${fmt(duration()).length * 2 + 3}ch`); // room for the longest time range
  els.status.textContent = '';
  els.list.replaceChildren();
  els.home.hidden = true;
  els.editor.hidden = false;
  resize();
  state.pps = Math.max(100, view.w / duration());
  renderAll();
}

async function closeProject() {
  if (!state.project) return;
  audio.pause();
  await save();
  state.project = null;
  audio.removeAttribute('src');
  audio.load();
}

let saveTimer;
let saveQueue = Promise.resolve();

function touch() {
  state.dirty = true;
  els.status.textContent = 'Unsaved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}

// Saves run one at a time; awaiting the result means everything is on disk.
function save() {
  clearTimeout(saveTimer);
  saveQueue = saveQueue.then(async () => {
    if (!state.dirty || !state.project) return;
    state.dirty = false;
    els.status.textContent = 'Saving…';
    const body = JSON.stringify(state.segments);
    try {
      await api(`/projects/${state.project.id}/segments`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
        keepalive: body.length < 60000, // lets a small save outlive the page
      });
      if (!state.dirty) els.status.textContent = 'Saved';
    } catch (err) {
      state.dirty = true;
      els.status.textContent = 'Save failed';
      toast(`Could not save: ${err.message}`);
    }
  });
  return saveQueue;
}

window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  save();
  e.preventDefault();
});

async function importLabels(file) {
  const form = new FormData();
  form.append('labels', file);
  try {
    const segments = await api(`/projects/${state.project.id}/labels`, { method: 'POST', body: form });
    pushUndo();
    Object.assign(state, { segments, speakers: speakersOf(segments), selected: null });
    renderAll();
    touch();
    toast(`Loaded ${segments.length} segments from ${file.name}. Ctrl+Z brings the old ones back.`);
  } catch (err) {
    toast(err.message);
  }
}

async function exportAs(format) {
  await save();
  if (state.dirty) return; // the save failed and said so
  h('a', { href: `/api/projects/${state.project.id}/export?format=${format}`, download: '' }).click();
}

// Undo --------------------------------------------------------------------

const snapshot = () => JSON.stringify({ segments: state.segments, speakers: state.speakers, selected: state.selected });

function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 100) state.undo.shift();
  state.redo.length = 0;
}

function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  Object.assign(state, JSON.parse(from.pop()));
  renderAll();
  touch();
}

// Rendering: speaker lanes and segment list -------------------------------

function renderAll() {
  renderLanes();
  renderList();
  draw();
}

function renderLanes() {
  els.lanes.replaceChildren(...state.speakers.map((name, i) =>
    h('button', { className: 'lane', title: 'Rename speaker', onclick: () => renameSpeaker(name) },
      h('i', { style: `background:${color(i)}` }), h('span', {}, name), i < 9 ? h('kbd', {}, String(i + 1)) : '')));
  resize();
}

const timeRange = (s) => `${fmt(s.start)} – ${fmt(s.end)}`;

function rowEl(s) {
  const row = h('div', { className: 'row', dataset: { id: s.id } },
    h('button', { className: 'time', title: 'Play segment' }),
    h('button', { className: 'spk', title: 'Change speaker' }),
    h('div', { className: 'grow' }, h('textarea', { rows: 1, placeholder: '…', spellcheck: true })));
  updateRow(row, s);
  return row;
}

function updateRow(row, s) {
  const [time, speaker, grow] = row.children, textarea = grow.firstChild;
  const range = timeRange(s), tint = color(state.speakers.indexOf(s.speaker));
  row.classList.toggle('sel', s.id === state.selected);
  if (time.textContent !== range) time.textContent = range;
  if (speaker.textContent !== s.speaker) speaker.textContent = s.speaker;
  if (speaker.style.getPropertyValue('--c') !== tint) speaker.style.setProperty('--c', tint);
  speaker.classList.toggle('verified', !!s.verified);
  if (textarea.value !== s.text) textarea.value = s.text;
  if (grow.dataset.value !== s.text) grow.dataset.value = s.text;
}

// Bring the list in line with state.segments, reusing the rows that are already
// there: only what changed touches the DOM, so long recordings stay quick and
// the text field being typed in keeps its focus.
function renderList() {
  const active = inTextField() ? document.activeElement : null;
  const caret = active?.selectionStart;
  const ids = new Set(state.segments.map((s) => s.id));
  const rows = new Map();
  for (const row of [...els.list.children]) {
    if (ids.has(row.dataset.id)) rows.set(row.dataset.id, row);
    else row.remove();
  }
  let next = els.list.firstElementChild;
  for (const s of state.segments) {
    let row = rows.get(s.id);
    if (row) updateRow(row, s);
    else row = rowEl(s);
    if (row === next) next = next.nextElementSibling;
    else els.list.insertBefore(row, next);
  }
  const verified = state.segments.filter((s) => s.verified).length;
  els.count.textContent = `${countLabel(state.segments.length)} · ${verified} verified`;
  // Moving a row to a new position drops its focus.
  if (active?.isConnected && document.activeElement !== active) {
    active.focus({ preventScroll: true });
    active.setSelectionRange(caret, caret);
  }
}

function sortSegments() {
  state.segments.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Selection and playback --------------------------------------------------

function select(id, { play = false, focus = false, seek: moveHead = true, reveal: scroll = true } = {}) {
  if (state.selected !== id) {
    rowOf(state.selected)?.classList.remove('sel');
    state.selected = id;
  }
  const s = seg(id), row = rowOf(id);
  if (!s || !row) return draw();
  row.classList.add('sel');
  row.scrollIntoView({ block: 'nearest' });
  if (focus) row.querySelector('textarea').focus({ preventScroll: true });
  if (scroll) reveal(s.start, s.end);
  if (play) playSegment(s);
  else if (moveHead && audio.paused) audio.currentTime = s.start;
  draw();
}

// Move to the neighbouring segment, or to the one at the playhead if none is selected.
function step(dir, focus = false) {
  const segments = state.segments;
  let i = selIndex();
  if (i < 0) {
    i = segments.findIndex((s) => s.end > audio.currentTime);
    if (i < 0) i = segments.length - 1;
  } else {
    i += dir;
  }
  if (i < 0 || i >= segments.length) return;
  select(segments[i].id, { play: els.autoplay.checked, focus });
}

function playSegment(s) {
  state.playSeg = s.id;
  audio.currentTime = s.start;
  audio.play().catch(() => {});
}

function togglePlay() {
  if (!audio.paused) return audio.pause();
  const s = seg(state.selected), t = audio.currentTime;
  if (s && Math.abs(t - s.end) < 0.05) return playSegment(s); // stopped at its end: play it again
  state.playSeg = s && t >= s.start && t < s.end ? s.id : null;
  audio.play().catch(() => {});
}

function replay() {
  const s = seg(state.selected);
  if (s) playSegment(s);
}

function seek(t) {
  state.playSeg = null;
  audio.currentTime = clamp(t, 0, duration());
  draw();
}

function setRate() {
  audio.defaultPlaybackRate = audio.playbackRate = Number(els.rate.value);
}

function tick() {
  if (audio.paused || !state.project) return;
  const s = seg(state.playSeg);
  if (s && audio.currentTime >= s.end) {
    audio.pause();
    audio.currentTime = s.end;
  }
  const x = t2x(audio.currentTime);
  if (!drag && (x < 0 || x > view.w - 24)) {
    state.left = audio.currentTime - (view.w * 0.1) / state.pps;
    clampView();
  }
  draw();
  requestAnimationFrame(tick);
}

audio.addEventListener('play', tick);
for (const type of ['pause', 'seeked', 'timeupdate', 'loadedmetadata']) audio.addEventListener(type, draw);
audio.addEventListener('error', () => state.project && toast('The audio could not be loaded.'));

// Editing -----------------------------------------------------------------

function newSpeakerName() {
  let i = 0;
  while (state.speakers.includes(`speaker_${i}`)) i++;
  return `speaker_${i}`;
}

function addSegment(start, end, speaker, focus) {
  pushUndo();
  speaker ||= seg(state.selected)?.speaker || state.speakers[0] || newSpeakerName();
  const s = { id: uid(), start: round3(start), end: round3(end), speaker, text: '', verified: false };
  state.segments.push(s);
  sortSegments();
  if (!state.speakers.includes(speaker)) state.speakers.push(speaker);
  state.selected = s.id;
  renderAll();
  select(s.id, { focus, seek: false });
  touch();
}

function newAtPlayhead() {
  const start = audio.currentTime, end = Math.min(start + NEW_LEN, duration());
  if (end - start >= MIN_LEN) addSegment(start, end, null, inTextField());
}

function setEdge(edge) {
  const s = seg(state.selected), t = round3(audio.currentTime);
  if (!s) return;
  if (edge === 'start' ? t > s.end - MIN_LEN : t < s.start + MIN_LEN) {
    return toast(edge === 'start' ? 'The playhead is past the end of the segment.' : 'The playhead is before the start of the segment.');
  }
  pushUndo();
  s[edge] = t;
  commitTimes(s);
}

// After a segment's times change: keep the list in order and its label current.
function commitTimes(s) {
  const before = state.segments.map((x) => x.id).join();
  sortSegments();
  if (state.segments.map((x) => x.id).join() !== before) renderList();
  else updateRow(rowOf(s.id), s);
  touch();
  draw();
}

function split() {
  const s = seg(state.selected), t = round3(audio.currentTime);
  if (!s) return;
  if (t < s.start + MIN_LEN || t > s.end - MIN_LEN) return toast('Put the playhead inside the segment to split it there.');
  pushUndo();
  // While typing, the text cursor decides which words go to which half.
  const active = document.activeElement;
  const cut = inTextField() && active.closest('.row').dataset.id === s.id ? active.selectionStart : s.text.length;
  state.segments.push({ id: uid(), start: t, end: s.end, speaker: s.speaker, text: s.text.slice(cut).trim(), verified: s.verified });
  s.text = s.text.slice(0, cut).trim();
  s.end = t;
  sortSegments();
  renderList();
  touch();
  draw();
}

function merge() {
  const i = selIndex(), a = state.segments[i], b = state.segments[i + 1];
  if (!a || !b) return;
  pushUndo();
  a.end = Math.max(a.end, b.end);
  a.text = [a.text, b.text].filter(Boolean).join(' ');
  state.segments.splice(i + 1, 1);
  renderList();
  touch();
  draw();
}

function remove() {
  const i = selIndex();
  if (i < 0) return;
  const focus = inTextField();
  pushUndo();
  state.segments.splice(i, 1);
  const next = state.segments[i] || state.segments[i - 1];
  state.selected = null;
  renderList();
  if (next) select(next.id, { focus });
  touch();
  draw();
}

function setSpeaker(name) {
  const s = seg(state.selected);
  if (!s || (s.speaker === name && s.verified)) return;
  pushUndo();
  s.speaker = name;
  s.verified = true; // a speaker chosen by hand needs no further confirmation
  if (!state.speakers.includes(name)) state.speakers.push(name);
  renderAll();
  touch();
}

function toggleVerified() {
  const s = seg(state.selected);
  if (!s) return;
  pushUndo();
  s.verified = !s.verified;
  renderList();
  touch();
  draw();
}

// Ask the server which speaker each unverified segment sounds like, judging
// from the verified ones, and apply the answers as one undoable change.
let relabelling = false;
async function relabel() {
  if (relabelling) return;
  const verified = state.segments.filter((s) => s.verified).length;
  if (!verified) return toast('Verify a few segments first: press V on one whose speaker is right, or assign its speaker.');
  const id = state.project.id;
  relabelling = true;
  els.relabel.disabled = true;
  els.relabel.textContent = 'Relabelling…';
  try {
    await save(); // the server works from what is on disk
    if (state.dirty) return;
    const result = await api(`/projects/${id}/relabel`, { method: 'POST' });
    if (state.project?.id !== id) return;
    // Edits may have happened while waiting, so check each segment again.
    const changes = state.segments.filter((s) => !s.verified && result.labels[s.id] && result.labels[s.id] !== s.speaker);
    if (changes.length) {
      pushUndo();
      for (const s of changes) {
        s.speaker = result.labels[s.id];
        if (!state.speakers.includes(s.speaker)) state.speakers.push(s.speaker);
      }
      renderAll();
      touch();
    }
    const left = result.uncertain + result.too_short;
    toast((changes.length ? `Changed the speaker of ${countLabel(changes.length)}` : 'No speakers needed changing')
      + `, judging from ${verified} verified.`
      + (left ? ` ${left} left alone: unlike every verified speaker, or too short to tell.` : ''));
  } catch (err) {
    toast(err.message);
  } finally {
    relabelling = false;
    els.relabel.disabled = false;
    els.relabel.textContent = 'Relabel speakers';
  }
}

// Keys 1-9: an existing speaker, or a new one for the first unused number.
const speakerForKey = (n) => state.speakers[n - 1] || newSpeakerName();

function renameSpeaker(old) {
  const name = prompt('Speaker name', old)?.trim();
  if (!name || name === old) return;
  pushUndo();
  for (const s of state.segments) if (s.speaker === old) s.speaker = name;
  state.speakers = state.speakers.includes(name)
    ? state.speakers.filter((x) => x !== old) // renamed onto an existing speaker: the two merge
    : state.speakers.map((x) => (x === old ? name : x));
  renderAll();
  touch();
}

function openSpeakerMenu(anchor) {
  const item = (label, name, i) => h('button', {
    onclick: () => {
      els.menu.hidden = true;
      setSpeaker(name);
    },
  }, i === undefined ? '' : h('i', { style: `background:${color(i)}` }), label, i < 9 ? h('kbd', {}, String(i + 1)) : '');
  els.menu.replaceChildren(...state.speakers.map((name, i) => item(name, name, i)), item('+ New speaker', newSpeakerName()));
  els.menu.hidden = false;
  const box = anchor.getBoundingClientRect(), height = els.menu.offsetHeight;
  els.menu.style.left = `${box.left}px`;
  els.menu.style.top = `${box.bottom + height + 4 > innerHeight ? Math.max(4, box.top - height - 4) : box.bottom + 4}px`;
}

document.addEventListener('pointerdown', (e) => {
  if (!els.menu.contains(e.target)) els.menu.hidden = true;
});

// Segment list events -----------------------------------------------------

let editing = null; // id of the segment whose text has an undo step for this visit

els.list.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  if (e.target.closest('.time')) return select(row.dataset.id, { play: true });
  if (e.target.closest('textarea')) return;
  select(row.dataset.id);
  if (e.target.closest('.spk')) openSpeakerMenu(e.target.closest('.spk'));
});

els.list.addEventListener('focusin', (e) => {
  const id = e.target.closest('.row')?.dataset.id;
  if (e.target.tagName === 'TEXTAREA' && id !== state.selected) select(id);
});

els.list.addEventListener('focusout', () => (editing = null));

els.list.addEventListener('input', (e) => {
  const textarea = e.target, s = seg(textarea.closest('.row').dataset.id);
  if (editing !== s.id) {
    pushUndo(); // s.text still holds the text from before this edit
    editing = s.id;
  }
  if (/[\r\n]/.test(textarea.value)) textarea.value = textarea.value.replace(/\s*[\r\n]+\s*/g, ' '); // pasted line breaks
  s.text = textarea.value;
  textarea.parentNode.dataset.value = s.text;
  touch();
  draw();
});

// Timeline: view ----------------------------------------------------------

function clampView() {
  state.pps = clamp(state.pps, view.w / duration(), Math.max(2000, view.w / duration()));
  state.left = clamp(state.left, 0, Math.max(0, duration() - view.w / state.pps));
}

function reveal(start, end) {
  const span = view.w / state.pps;
  if (start >= state.left && end <= state.left + span) return;
  state.left = end - start < span ? (start + end) / 2 - span / 2 : start - span * 0.1;
  clampView();
}

function zoom(factor, x) {
  if (x === undefined) {
    const head = t2x(audio.currentTime);
    x = head >= 0 && head <= view.w ? head : view.w / 2;
  }
  const t = x2t(x);
  state.pps = clamp(state.pps * factor, view.w / duration(), Math.max(2000, view.w / duration()));
  state.left = t - x / state.pps;
  clampView();
  draw();
}

function resize() {
  if (!state.project) return;
  const dpr = window.devicePixelRatio || 1;
  view.w = els.stage.clientWidth;
  view.h = RULER_H + WAVE_H + Math.max(1, state.speakers.length) * LANE_H;
  canvas.style.height = `${view.h}px`;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  clampView();
  paint();
}

function readTheme() {
  const style = getComputedStyle(document.documentElement);
  for (const key of ['bg', 'fg', 'muted', 'line', 'accent', 'wave', 'sel', 'playhead']) {
    theme[key] = style.getPropertyValue(`--${key}`).trim();
  }
  draw();
}

// Timeline: drawing -------------------------------------------------------

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    paint();
  });
}

function paint() {
  if (!state.project) return;
  const dpr = window.devicePixelRatio || 1;
  const w = view.w, total = duration(), now = audio.currentTime, top = RULER_H + WAVE_H;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, view.h);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  // Ruler ticks and lane separators.
  const tickStep = TICKS.find((s) => s * state.pps >= 70) || 3600;
  const lastTick = Math.min(total, x2t(w));
  ctx.fillStyle = theme.muted;
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = Math.ceil(state.left / tickStep); k * tickStep <= lastTick; k++) {
    const x = Math.round(t2x(k * tickStep)) + 0.5;
    ctx.moveTo(x, RULER_H - 6);
    ctx.lineTo(x, RULER_H);
    ctx.fillText(fmt(k * tickStep, tickStep < 1 ? 1 : 0), x + 4, RULER_H / 2);
  }
  for (let y = top + 0.5; y < view.h; y += LANE_H) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  // The selected segment, marked on the waveform so its edges can be judged against it.
  const selected = seg(state.selected);
  if (selected) {
    const x0 = Math.round(t2x(selected.start)), x1 = Math.round(t2x(selected.end));
    ctx.fillStyle = theme.sel;
    ctx.fillRect(x0, RULER_H, x1 - x0, WAVE_H);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x0, RULER_H, 1, WAVE_H);
    ctx.fillRect(x1 - 1, RULER_H, 1, WAVE_H);
  }

  // Waveform: one column per pixel spanning the min and max of the peaks under it.
  const peaks = state.peaks, count = peaks.length >> 1, rate = state.project.peaks_per_sec;
  const mid = RULER_H + WAVE_H / 2;
  ctx.fillStyle = theme.wave;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x2t(x) * rate);
    if (a >= count) break;
    const b = Math.min(count, Math.max(a + 1, Math.floor(x2t(x + 1) * rate)));
    let lo = 127, hi = -128;
    for (let i = a; i < b; i++) {
      if (peaks[2 * i] < lo) lo = peaks[2 * i];
      if (peaks[2 * i + 1] > hi) hi = peaks[2 * i + 1];
    }
    ctx.fillRect(x, mid - hi * state.gain, 1, Math.max(1, (hi - lo) * state.gain));
  }

  // Segments, one lane per speaker.
  for (const s of state.segments) {
    const x0 = t2x(s.start), x1 = t2x(s.end);
    if (x1 < 0 || x0 > w) continue;
    const lane = state.speakers.indexOf(s.speaker), y = top + lane * LANE_H + 4, height = LANE_H - 7;
    const isSelected = s === selected;
    ctx.beginPath();
    ctx.roundRect(x0, y, Math.max(x1 - x0, 2), height, 3);
    ctx.globalAlpha = s.verified ? 0.85 : 0.4; // solid once the speaker is verified
    ctx.fillStyle = color(lane);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (isSelected) {
      ctx.strokeStyle = theme.fg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (s.text && x1 - x0 > 28) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = theme.fg;
      ctx.fillText(s.text, Math.max(x0, 0) + 5, y + height / 2 + 0.5);
      ctx.restore();
    }
  }

  // A segment being drawn with the mouse.
  if (drag?.type === 'press' && drag.moved && !drag.seg) {
    const x0 = t2x(Math.min(drag.t0, drag.t1)), x1 = t2x(Math.max(drag.t0, drag.t1));
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x0, RULER_H, x1 - x0, view.h - RULER_H);
    ctx.globalAlpha = 1;
  }

  // Playhead.
  ctx.fillStyle = theme.playhead;
  ctx.fillRect(Math.round(t2x(now)) - 0.75, 0, 1.5, view.h);

  els.thumb.style.left = `${(state.left / total) * 100}%`;
  els.thumb.style.width = `${Math.min(1, view.w / state.pps / total) * 100}%`;
  els.clock.textContent = `${fmt(now)} / ${fmt(total)}`;
  els.play.textContent = audio.paused ? '▶' : '❚❚';
}

// Timeline: mouse ---------------------------------------------------------

let drag = null;

const pointerPos = (e) => {
  const box = canvas.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
};
const laneAt = (y) => (y < RULER_H + WAVE_H ? -1 : Math.floor((y - RULER_H - WAVE_H) / LANE_H));

// What is under the pointer: a segment's edge, its body, or nothing.
function hitTest(x, y) {
  const lane = laneAt(y);
  const edgeOf = (s, reach) => {
    const x0 = t2x(s.start), x1 = t2x(s.end), inner = Math.min(EDGE, (x1 - x0) / 3);
    if (x >= x0 - reach && x <= x0 + inner) return 'start';
    if (x >= x1 - inner && x <= x1 + reach) return 'end';
    return null;
  };
  // The selected segment's edges can also be grabbed on the waveform.
  const selected = seg(state.selected);
  if (selected && (lane < 0 || state.speakers[lane] === selected.speaker)) {
    const edge = edgeOf(selected, EDGE);
    if (edge) return { seg: selected, edge };
  }
  if (lane < 0) return null;
  const inLane = state.segments.filter((s) => s.speaker === state.speakers[lane]);
  // Prefer an edge of the segment under the pointer over a neighbour's edge just outside it.
  for (const reach of [0, EDGE]) {
    for (const s of inLane) {
      const edge = edgeOf(s, reach);
      if (edge) return { seg: s, edge };
    }
  }
  const body = inLane.find((s) => x >= t2x(s.start) && x <= t2x(s.end));
  return body ? { seg: body } : null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const { x, y } = pointerPos(e), hit = hitTest(x, y);
  canvas.setPointerCapture(e.pointerId);
  if (hit?.edge) {
    select(hit.seg.id, { seek: false, reveal: false });
    drag = { type: 'resize', seg: hit.seg, edge: hit.edge, moved: false };
  } else {
    drag = { type: 'press', x0: x, t0: clamp(x2t(x), 0, duration()), seg: hit?.seg, lane: laneAt(y), moved: false };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const { x, y } = pointerPos(e);
  if (!drag) {
    canvas.style.cursor = hitTest(x, y)?.edge ? 'ew-resize' : 'default';
    return;
  }
  const t = clamp(x2t(x), 0, duration());
  if (drag.type === 'resize') {
    const s = drag.seg;
    if (!drag.moved) pushUndo();
    drag.moved = true;
    if (drag.edge === 'start') s.start = round3(Math.min(t, s.end - MIN_LEN));
    else s.end = round3(Math.max(t, s.start + MIN_LEN));
    updateRow(rowOf(s.id), s);
    draw();
  } else if (drag.moved || Math.abs(x - drag.x0) > 4) {
    drag.moved = true;
    drag.t1 = t;
    draw();
  }
});

canvas.addEventListener('pointerup', () => {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.type === 'resize') {
    if (d.moved) commitTimes(d.seg);
  } else if (d.moved && !d.seg) {
    const start = Math.min(d.t0, d.t1), end = Math.max(d.t0, d.t1);
    if (end - start >= MIN_LEN) addSegment(start, end, state.speakers[d.lane], true);
  } else {
    if (d.seg) select(d.seg.id, { seek: false, reveal: false });
    seek(d.t0);
  }
  draw();
});

canvas.addEventListener('pointercancel', () => {
  drag = null;
  draw();
});

canvas.addEventListener('dblclick', (e) => {
  const { x, y } = pointerPos(e), hit = hitTest(x, y);
  if (hit) select(hit.seg.id, { play: true, reveal: false });
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const lines = e.deltaMode === 1 ? 16 : 1; // Firefox reports mouse wheels in lines
  if (e.ctrlKey || e.metaKey) {
    zoom(Math.exp(-clamp(e.deltaY * lines, -50, 50) * 0.01), pointerPos(e).x);
  } else {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    state.left += (delta * lines) / state.pps;
    clampView();
    draw();
  }
}, { passive: false });

function scrubMinimap(e) {
  const box = els.minimap.getBoundingClientRect();
  state.left = ((e.clientX - box.left) / box.width) * duration() - view.w / state.pps / 2;
  clampView();
  draw();
}
els.minimap.addEventListener('pointerdown', (e) => {
  els.minimap.setPointerCapture(e.pointerId);
  scrubMinimap(e);
});
els.minimap.addEventListener('pointermove', (e) => e.buttons && scrubMinimap(e));

// Controls ----------------------------------------------------------------

els.play.addEventListener('click', togglePlay);
els.rate.addEventListener('change', setRate);
els.autoplay.checked = localStorage.getItem('autoplay') !== 'off';
els.autoplay.addEventListener('change', () => localStorage.setItem('autoplay', els.autoplay.checked ? 'on' : 'off'));
$('#zoom-in').addEventListener('click', () => zoom(1.5));
$('#zoom-out').addEventListener('click', () => zoom(1 / 1.5));
els.relabel.addEventListener('click', relabel);
$('#export-rttm').addEventListener('click', () => exportAs('rttm'));
$('#export-nemo').addEventListener('click', () => exportAs('nemo'));
$('#open-help').addEventListener('click', () => els.help.showModal());
$('#in-import').addEventListener('change', (e) => {
  if (e.target.files[0]) importLabels(e.target.files[0]);
  e.target.value = '';
});

// Controls give focus back after use, so the bare hotkeys keep working.
els.editor.addEventListener('click', (e) => {
  if (e.target.closest('button, .btn, .check')) document.activeElement.blur();
});
els.rate.addEventListener('change', () => els.rate.blur());

// Hotkeys -----------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (!state.project || els.help.open || e.isComposing || e.keyCode === 229) return;
  const typing = e.target.tagName === 'TEXTAREA';
  const run = (fn) => {
    e.preventDefault();
    fn();
  };

  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyS') run(save);
    else if (!typing && e.code === 'KeyZ') run(() => (e.shiftKey ? restore(state.redo, state.undo) : restore(state.undo, state.redo)));
    else if (!typing && e.code === 'KeyY') run(() => restore(state.redo, state.undo));
    return;
  }

  if (e.key === 'Enter') {
    // From outside a text field, Enter first drops into the selected segment's text.
    if (!typing && !e.shiftKey && seg(state.selected)) return run(() => select(state.selected, { focus: true, seek: false }));
    return run(() => step(e.shiftKey ? -1 : 1, true));
  }
  if (e.key === 'Tab') return run(e.shiftKey ? replay : togglePlay);
  if (e.key === 'Escape') {
    els.menu.hidden = true;
    if (typing) e.target.blur();
    return;
  }

  // Editing commands: the bare key outside a text field, Alt+key inside one.
  if (typing !== e.altKey) return;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (digit) return run(() => setSpeaker(speakerForKey(Number(digit[1]))));
  const edit = {
    KeyN: newAtPlayhead, KeyS: split, KeyM: merge, KeyX: remove, KeyV: toggleVerified, KeyR: relabel,
    BracketLeft: () => setEdge('start'), BracketRight: () => setEdge('end'),
  }[e.code];
  if (edit) return run(edit);
  if (typing) return;

  if (e.key === '?') return run(() => els.help.showModal());
  const jump = e.shiftKey ? 5 : 1;
  const move = {
    Space: togglePlay, Delete: remove, Backspace: remove,
    ArrowDown: () => step(1), ArrowUp: () => step(-1),
    ArrowLeft: () => seek(audio.currentTime - jump), ArrowRight: () => seek(audio.currentTime + jump),
    Equal: () => zoom(1.5), NumpadAdd: () => zoom(1.5), Minus: () => zoom(1 / 1.5), NumpadSubtract: () => zoom(1 / 1.5),
  }[e.code];
  if (move) run(move);
});

// Start -------------------------------------------------------------------

async function route() {
  const match = /^#\/p\/([0-9a-f]+)$/.exec(location.hash);
  await closeProject();
  try {
    if (match) await openProject(match[1]);
    else await showHome();
  } catch (err) {
    toast(err.message);
    if (match) location.hash = '#/';
  }
}

els.timeline.style.setProperty('--head', `${RULER_H + WAVE_H}px`);
els.timeline.style.setProperty('--lane', `${LANE_H}px`);
new ResizeObserver(resize).observe(els.stage);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
window.addEventListener('hashchange', route);
readTheme();
route();
