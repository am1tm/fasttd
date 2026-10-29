// Service worker: decides what to accelerate, probes servers, spots media on
// pages, and hands finished files to Chrome's download manager. The actual
// segmented download runs in the offscreen document (offscreen.js), because
// only a document can hold blob URLs and keep long transfers alive.

import { DEFAULTS } from './settings.js';
import { isHlsMime, isHlsUrl, loadHls } from './hls.js';

const MB = 1024 * 1024;

// Don't take over a browser download that is already this far along.
const TAKEOVER_MAX_PROGRESS = 0.5;
// Media smaller than this is usually an ad, a preview or a tracking pixel.
const MIN_MEDIA_BYTES = 300 * 1024;
const MAX_MEDIA_PER_TAB = 30;

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

// Unfinished downloads live in OPFS; the engine picks them up when it loads.
async function hasSavedJobs() {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('jobs');
    for await (const _ of dir.keys()) return true;
  } catch {}
  return false;
}

async function resumeSavedJobs() {
  if (await hasSavedJobs()) await ensureOffscreen();
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

const sanitize = (name) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 180);

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
  return sanitize(name) || 'download';
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

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Playlist request failed (${res.status})`);
  return { text: await res.text(), finalUrl: res.url || url };
}

// Works out how to download a URL: a job spec for the engine, or null when
// the server can't do parallel downloads.
async function inspect(url, { allowHls, title }) {
  if (allowHls && isHlsUrl(url)) return hlsSpec(url, title);
  const info = await probe(url).catch(() => null);
  if (allowHls && isHlsMime(info?.mime ?? '')) return hlsSpec(info.finalUrl, title);
  if (!info?.rangeOk) return null;
  const { rangeOk, ...spec } = info;
  return { kind: 'range', ...spec, url: info.finalUrl };
}

async function hlsSpec(url, title) {
  const { segments, container, separateAudio } = await loadHls(url, fetchText);
  const base = sanitize(title || '') || filenameFrom(null, url).replace(/\.m3u8$/i, '');
  return {
    kind: 'hls',
    url,
    size: 0,
    segments,
    filename: `${base}.${container}`,
    mime: container === 'mp4' ? 'video/mp4' : 'video/mp2t',
    note: separateAudio ? 'This stream keeps its audio track separate, so the file may be silent.' : null,
  };
}

// browserDownloadId is set when we're taking over a download Chrome already
// started. In that case every failure path leaves Chrome's download alone.
async function accelerate({ url, referrer, title, browserDownloadId = null }) {
  if (!/^https?:/i.test(url)) {
    return { error: 'This media is streamed in pieces. Open fasttD on the page and pick it under This page.' };
  }
  const auto = browserDownloadId != null;
  const settings = await getSettings();
  const id = newJobId();
  await addRefererRule(id, url, referrer).catch(() => {});

  let spec;
  try {
    // A captured .m3u8 is the playlist file itself, which is what was asked for.
    spec = await inspect(url, { allowHls: !auto, title });
  } catch (e) {
    await removeRule(id);
    return { error: e.message };
  }
  if (!spec || (auto && spec.size < settings.minSizeMB * MB)) {
    await removeRule(id);
    if (auto) return {};
    await chrome.downloads.download({ url });
    return { fallback: true };
  }

  if (auto) {
    const [item] = await chrome.downloads.search({ id: browserDownloadId });
    const progress = item?.totalBytes > 0 ? item.bytesReceived / item.totalBytes : 0;
    if (item?.state !== 'in_progress' || progress > TAKEOVER_MAX_PROGRESS) {
      await removeRule(id);
      return {};
    }
    // Chrome's chosen name already accounts for the original request.
    const chromeName = item.filename.split(/[\\/]/).pop();
    if (chromeName) spec.filename = chromeName;
    await chrome.downloads.cancel(browserDownloadId);
    await chrome.downloads.erase({ id: browserDownloadId });
  }

  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    job: { ...spec, id, referrer, connections: settings.connections },
  });
  return { started: true };
}

async function finalizeSave(downloadId, state) {
  const key = `dl:${downloadId}`;
  const { [key]: jobId } = await chrome.storage.session.get(key);
  if (jobId == null) return;
  await chrome.storage.session.remove(key);
  if (state === 'complete') await removeRule(jobId);
  await chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'saved', jobId, downloadId, ok: state === 'complete' })
    .catch(() => {});
}

// --- Media on pages -------------------------------------------------------

const MEDIA_URL = /\.(mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|ogg|oga|opus|flac|wav|m3u8)($|[?#])/i;
// Individual stream segments: never useful on their own.
const SEGMENT_URL = /\.(ts|m4s|cmfv|cmfa)($|[?#])/i;
const SEGMENT_MIME = /^video\/(mp2t|iso\.segment)$/;

const mediaKey = (url) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};

let mediaWrites = Promise.resolve();
function rememberMedia(tabId, item) {
  mediaWrites = mediaWrites.then(async () => {
    const key = `media:${tabId}`;
    const { [key]: list = [] } = await chrome.storage.session.get(key);
    const id = mediaKey(item.url);
    const previous = list.find((m) => mediaKey(m.url) === id);
    const next = [{ ...item, size: item.size || previous?.size || 0 }, ...list.filter((m) => m !== previous)];
    await chrome.storage.session.set({ [key]: next.slice(0, MAX_MEDIA_PER_TAB) });
  }).catch(() => {});
}

function onMediaResponse(details) {
  if (details.tabId < 0 || details.statusCode >= 400 || !/^https?:/i.test(details.url)) return;
  const header = (name) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const mime = header('content-type').split(';')[0].trim().toLowerCase();
  const hls = isHlsUrl(details.url) || isHlsMime(mime);
  const looksLikeMedia = /^(video|audio)\//.test(mime) || (MEDIA_URL.test(details.url) && !mime.startsWith('text/html'));
  if (!hls && (!looksLikeMedia || SEGMENT_URL.test(details.url) || SEGMENT_MIME.test(mime))) return;
  // YouTube streams arrive as short-lived pieces that can't be saved on their own.
  if (new URL(details.url).hostname.endsWith('googlevideo.com')) return;
  const size = Number(header('content-range').match(/\/(\d+)/)?.[1] ?? header('content-length')) || 0;
  if (!hls && size && size < MIN_MEDIA_BYTES) return;
  rememberMedia(details.tabId, { url: details.url, mime, size, hls, at: Date.now() });
}

chrome.webRequest.onHeadersReceived.addListener(
  onMediaResponse,
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders'],
);

const forgetMedia = (tabId) => chrome.storage.session.remove(`media:${tabId}`);
chrome.tabs.onRemoved.addListener(forgetMedia);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) forgetMedia(tabId);
});

// --- Messages -------------------------------------------------------------

const handlers = {
  // From the popup.
  add: ({ url, referrer, title }) => accelerate({ url, referrer, title }),
  async wake() {
    await resumeSavedJobs();
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
  async rule({ jobId, url, referrer }) {
    await addRefererRule(jobId, url, referrer).catch(() => {});
    return {};
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

chrome.runtime.onStartup.addListener(resumeSavedJobs);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'fasttd',
    title: 'Download with fasttD',
    contexts: ['link', 'video', 'audio'],
  });
  // Reloading or updating the extension closes the engine too.
  resumeSavedJobs();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.srcUrl;
  if (url) accelerate({ url, referrer: info.pageUrl, title: tab?.title }).catch(console.error);
});
