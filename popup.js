import { DEFAULTS } from './settings.js';

const $ = (id) => document.getElementById(id);

const send = (target, type, extra = {}) =>
  chrome.runtime.sendMessage({ target, type, ...extra }).catch(() => undefined);

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function amount(job) {
  const pct = Math.floor(job.progress * 100);
  if (job.kind === 'hls') return `${fmtBytes(job.received)} · segment ${job.segments[0]} of ${job.segments[1]} (${pct}%)`;
  return `${fmtBytes(job.received)} of ${fmtBytes(job.size)} (${pct}%)`;
}

function describe(job) {
  switch (job.status) {
    case 'downloading': {
      const parts = [amount(job), `${fmtBytes(job.speed)}/s`, `${job.active}/${job.connections} conn`];
      if (job.eta) parts.push(`${fmtTime(job.eta)} left`);
      if (job.retries) parts.push(`${job.retries} retries`);
      return parts.join(' · ');
    }
    case 'paused': return `Paused · ${amount(job)}`;
    case 'saving': return 'Saving to disk…';
    case 'ready': return job.error ?? 'Ready to save';
    case 'done': return `${fmtBytes(job.received)} · averaged ${fmtBytes(job.speed)}/s`;
    case 'canceled': return 'Canceled';
    default: return job.error ?? 'Failed';
  }
}

const ACTIONS = {
  pause: ['downloading'],
  resume: ['paused'],
  save: ['ready'],
  show: ['done'],
  cancel: ['downloading', 'paused', 'ready'],
};

const rows = new Map();

function renderJobs(jobs) {
  const list = $('jobs');
  const seen = new Set();
  for (const job of jobs) {
    seen.add(job.id);
    let li = rows.get(job.id);
    if (!li) {
      li = $('jobTemplate').content.firstElementChild.cloneNode(true);
      li.dataset.id = job.id;
      rows.set(job.id, li);
    }
    list.appendChild(li); // keeps order in sync with the newest-first list
    li.dataset.status = job.status;
    li.dataset.downloadId = job.downloadId ?? '';
    li.querySelector('.name').textContent = job.filename;
    li.querySelector('.name').title = job.url;
    li.querySelector('.fill').style.width = `${['done', 'saving', 'ready'].includes(job.status) ? 100 : job.progress * 100}%`;
    li.querySelector('.meta').textContent = describe(job);
    li.querySelector('.note').textContent = job.note ?? '';
    li.querySelector('.note').hidden = !job.note;
    for (const button of li.querySelectorAll('[data-action]')) {
      const action = button.dataset.action;
      button.hidden = !ACTIONS[action].includes(job.status) || (action === 'show' && !job.downloadId);
    }
  }
  for (const [id, li] of rows) {
    if (!seen.has(id)) {
      li.remove();
      rows.delete(id);
    }
  }
  $('empty').hidden = jobs.length > 0;
}

async function refreshJobs() {
  const jobs = await send('offscreen', 'list');
  renderJobs(Array.isArray(jobs) ? jobs : []);
}

function showStatus(res) {
  const status = $('addStatus');
  status.hidden = !res?.error && !res?.fallback;
  status.classList.toggle('error', Boolean(res?.error));
  status.textContent = res?.error
    ?? (res?.fallback ? "This server doesn't allow split downloads, so Chrome is downloading it normally." : '');
}

// --- This page ------------------------------------------------------------

let currentTab = null;

function mediaName(item) {
  const path = new URL(item.url).pathname;
  let name = decodeURIComponent(path.split('/').pop() || path);
  if (item.hls) name = `${currentTab?.title || 'Stream'} (${name})`;
  return name;
}

function mediaMeta(item) {
  const parts = [item.hls ? 'HLS stream' : item.mime || 'media'];
  if (item.size) parts.push(fmtBytes(item.size));
  parts.push(new URL(item.url).hostname);
  return parts.join(' · ');
}

async function renderMedia() {
  if (!currentTab) return;
  const key = `media:${currentTab.id}`;
  const { [key]: items = [] } = await chrome.storage.session.get(key);
  const list = $('media');
  list.replaceChildren(...items.map((item) => {
    const li = $('mediaTemplate').content.firstElementChild.cloneNode(true);
    li.dataset.url = item.url;
    li.dataset.hls = item.hls ? '1' : '';
    li.querySelector('.name').textContent = mediaName(item);
    li.querySelector('.name').title = item.url;
    li.querySelector('.meta').textContent = mediaMeta(item);
    return li;
  }));
  $('mediaEmpty').hidden = items.length > 0;
  $('mediaCount').hidden = !items.length;
  $('mediaCount').textContent = items.length;
}

$('media').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-action="grab"]');
  const li = e.target.closest('.media');
  if (!button || !li) return;
  button.disabled = true;
  button.textContent = 'Starting…';
  const res = await send('background', 'add', {
    url: li.dataset.url,
    referrer: currentTab?.url,
    title: li.dataset.hls ? currentTab?.title : undefined,
  });
  showStatus(res);
  button.textContent = res?.error ? 'Failed' : 'Added';
  if (!res?.error) selectTab('downloads');
  refreshJobs();
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (currentTab && changes[`media:${currentTab.id}`]) renderMedia();
});

// --- Tabs, settings, actions ----------------------------------------------

function selectTab(name) {
  for (const button of document.querySelectorAll('.tabs button')) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  $('tab-downloads').hidden = name !== 'downloads';
  $('tab-page').hidden = name !== 'page';
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-tab]');
  if (button) selectTab(button.dataset.tab);
});

async function initSettings() {
  const select = $('connections');
  for (let n = 1; n <= 16; n++) select.add(new Option(String(n), String(n)));

  const settings = await chrome.storage.sync.get(DEFAULTS);
  $('autoCapture').checked = settings.autoCapture;
  select.value = String(settings.connections);
  $('minSizeMB').value = settings.minSizeMB;

  $('autoCapture').addEventListener('change', (e) => chrome.storage.sync.set({ autoCapture: e.target.checked }));
  select.addEventListener('change', (e) => chrome.storage.sync.set({ connections: Number(e.target.value) }));
  $('minSizeMB').addEventListener('change', (e) =>
    chrome.storage.sync.set({ minSizeMB: Math.max(0, Number(e.target.value) || 0) }));
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('url');
  const url = input.value.trim();
  if (!url) return;
  input.value = '';
  showStatus(await send('background', 'add', { url }));
  refreshJobs();
});

$('jobs').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-action]');
  const li = e.target.closest('.job');
  if (!button || !li) return;
  if (button.dataset.action === 'show') {
    chrome.downloads.show(Number(li.dataset.downloadId));
    return;
  }
  await send('offscreen', button.dataset.action, { jobId: Number(li.dataset.id) });
  refreshJobs();
});

$('clear').addEventListener('click', async () => {
  await send('offscreen', 'clear');
  refreshJobs();
});

initSettings();
// Brings back downloads left unfinished by a browser restart, if the engine
// isn't running yet.
send('background', 'wake').then(refreshJobs);
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  currentTab = tab ?? null;
  renderMedia();
});
setInterval(refreshJobs, 700);
