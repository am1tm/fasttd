// Service worker: decides what to accelerate, probes servers, and hands
// finished files to Chrome's download manager. The actual segmented
// download runs in the offscreen document (offscreen.js), because only a
// document can hold blob URLs and keep long transfers alive.

const MB = 1024 * 1024;
const DEFAULTS = { autoCapture: true, connections: 6, minSizeMB: 5 };

// Don't take over a browser download that is already this far along.
const TAKEOVER_MAX_PROGRESS = 0.5;

const getSettings = () => chrome.storage.sync.get(DEFAULTS);

let seq = 0;
// DNR rule ids must be positive 32-bit ints, and job ids double as rule ids.
const newJobId = () => (Math.floor(Date.now() / 1000) % 1e6) * 1000 + (seq++ % 1000) + 1;

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble parallel download segments into a single file',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

// fetch() can't set Referer, but some hosts refuse downloads without it.
// A session rule scoped to this extension's own requests fills it in.
async function addRefererRule(id, url, referrer) {
  if (!referrer) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: referrer }],
      },
      condition: {
        requestDomains: [new URL(url).hostname],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    }],
  });
}

const removeRule = (id) =>
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});

export function filenameFrom(contentDisposition, url) {
  let name = '';
  if (contentDisposition) {
    const star = contentDisposition.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
    const plain = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    try {
      name = star ? decodeURIComponent(star[1].trim()) : (plain?.[1].trim() ?? '');
    } catch {
      name = plain?.[1].trim() ?? '';
    }
  }
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch {}
  }
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+/, '').trim();
  return name || 'download';
}

// Ask for one byte to learn whether the server supports ranges and how big
// the file is. The body is aborted right away so a 200 doesn't download it.
async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      credentials: 'include',
      signal: ctrl.signal,
    });
    const total = Number(res.headers.get('content-range')?.match(/\/(\d+)\s*$/)?.[1] ?? 0);
    const etag = res.headers.get('etag');
    return {
      rangeOk: res.status === 206 && total > 0,
      size: total || Number(res.headers.get('content-length') ?? 0),
      finalUrl: res.url || url,
      filename: filenameFrom(res.headers.get('content-disposition'), res.url || url),
      mime: res.headers.get('content-type')?.split(';')[0] ?? '',
      // If-Range only accepts strong validators.
      validator: etag && !etag.startsWith('W/') ? etag : res.headers.get('last-modified'),
    };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

// browserDownloadId is set when we're taking over a download Chrome already
// started. In that case every failure path leaves Chrome's download alone.
async function accelerate({ url, referrer, browserDownloadId = null }) {
  const settings = await getSettings();
  const id = newJobId();
  await addRefererRule(id, url, referrer).catch(() => {});

  const info = await probe(url).catch(() => null);
  const auto = browserDownloadId != null;
  if (!info?.rangeOk || (auto && info.size < settings.minSizeMB * MB)) {
    await removeRule(id);
    if (!auto) await chrome.downloads.download({ url });
    return;
  }

  let filename = info.filename;
  if (auto) {
    const [item] = await chrome.downloads.search({ id: browserDownloadId });
    const progress = item?.totalBytes > 0 ? item.bytesReceived / item.totalBytes : 0;
    if (item?.state !== 'in_progress' || progress > TAKEOVER_MAX_PROGRESS) {
      await removeRule(id);
      return;
    }
    // Chrome's chosen name already accounts for the original request.
    const chromeName = item.filename.split(/[\\/]/).pop();
    if (chromeName) filename = chromeName;
    await chrome.downloads.cancel(browserDownloadId);
    await chrome.downloads.erase({ id: browserDownloadId });
  }

  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    job: {
      id,
      url: info.finalUrl,
      size: info.size,
      filename,
      mime: info.mime,
      validator: info.validator,
      connections: settings.connections,
    },
  });
}

async function finalizeSave(downloadId, state) {
  const key = `dl:${downloadId}`;
  const { [key]: jobId } = await chrome.storage.session.get(key);
  if (jobId == null) return;
  await chrome.storage.session.remove(key);
  if (state === 'complete') await removeRule(jobId);
  await chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'saved', jobId, ok: state === 'complete' })
    .catch(() => {});
}

const handlers = {
  // From the popup.
  async add({ url }) {
    await accelerate({ url });
    return {};
  },
  async ensureOffscreen() {
    await ensureOffscreen();
    return {};
  },

  // From the offscreen document.
  async save({ jobId, blobUrl, filename }) {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename,
      conflictAction: 'uniquify',
    });
    await chrome.storage.session.set({ [`dl:${downloadId}`]: jobId });
    // Small files can finish before the mapping above is stored.
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && item.state !== 'in_progress') await finalizeSave(downloadId, item.state);
    return { downloadId };
  },
  async finished({ jobId }) {
    await removeRule(jobId);
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background' || !handlers[msg.type]) return;
  handlers[msg.type](msg).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

chrome.downloads.onCreated.addListener(async (item) => {
  if (item.byExtensionId === chrome.runtime.id) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url) || item.state !== 'in_progress') return;
  const settings = await getSettings();
  if (!settings.autoCapture) return;
  if (item.totalBytes > 0 && item.totalBytes < settings.minSizeMB * MB) return;
  accelerate({ url, referrer: item.referrer, browserDownloadId: item.id }).catch(console.error);
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') finalizeSave(delta.id, state);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'fasttd',
    title: 'Download with fasttD',
    contexts: ['link', 'video', 'audio'],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.srcUrl;
  if (url) accelerate({ url, referrer: info.pageUrl }).catch(console.error);
});
