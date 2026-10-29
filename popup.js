const DEFAULTS = { autoCapture: true, connections: 6, minSizeMB: 5 };

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

function describe(job) {
  const pct = job.size ? Math.floor((job.received / job.size) * 100) : 0;
  switch (job.status) {
    case 'downloading': {
      const eta = job.speed ? fmtTime((job.size - job.received) / job.speed) : '';
      const parts = [
        `${fmtBytes(job.received)} of ${fmtBytes(job.size)} (${pct}%)`,
        `${fmtBytes(job.speed)}/s`,
        `${job.active}/${job.connections} conn`,
      ];
      if (eta) parts.push(`${eta} left`);
      if (job.retries) parts.push(`${job.retries} retries`);
      return parts.join(' · ');
    }
    case 'paused': return `Paused · ${fmtBytes(job.received)} of ${fmtBytes(job.size)} (${pct}%)`;
    case 'saving': return 'Saving to disk…';
    case 'ready': return job.error ?? 'Ready to save';
    case 'done': return `${fmtBytes(job.size)} · averaged ${fmtBytes(job.speed)}/s`;
    case 'canceled': return 'Canceled';
    default: return job.error ?? 'Failed';
  }
}

const rows = new Map();

function render(jobs) {
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
    li.querySelector('.name').textContent = job.filename;
    li.querySelector('.name').title = job.url;
    li.querySelector('.fill').style.width = `${job.size ? (job.received / job.size) * 100 : 0}%`;
    li.querySelector('.meta').textContent = describe(job);
    const visible = {
      pause: job.status === 'downloading',
      resume: job.status === 'paused',
      save: job.status === 'ready',
      cancel: ['downloading', 'paused', 'ready'].includes(job.status),
    };
    for (const button of li.querySelectorAll('[data-action]')) button.hidden = !visible[button.dataset.action];
  }
  for (const [id, li] of rows) {
    if (!seen.has(id)) {
      li.remove();
      rows.delete(id);
    }
  }
  $('empty').hidden = jobs.length > 0;
}

async function refresh() {
  const jobs = await send('offscreen', 'list');
  render(Array.isArray(jobs) ? jobs : []);
}

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
  await send('background', 'add', { url });
  refresh();
});

$('jobs').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-action]');
  const li = e.target.closest('.job');
  if (!button || !li) return;
  await send('offscreen', button.dataset.action, { jobId: Number(li.dataset.id) });
  refresh();
});

$('clear').addEventListener('click', async () => {
  await send('offscreen', 'clear');
  refresh();
});

initSettings();
refresh();
setInterval(refresh, 700);
