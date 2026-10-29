// Download engine. Fetches a file in pieces over N parallel connections,
// streams each piece to its own file in the origin-private file system (so
// large downloads never sit in memory), then joins the pieces into one Blob
// and asks the service worker to save it.
//
// Two kinds of job:
//   range: one file split into byte ranges. Idle connections steal the back
//          half of the slowest remaining range, like IDM.
//   hls:   a video stream; each piece is one playlist segment.
//
// Every job keeps a meta.json next to its pieces, so unfinished downloads
// survive a browser restart.

const MB = 1024 * 1024;
const MAX_ATTEMPTS = 5;
// Pieces are committed to disk when a connection finishes, pauses or drops,
// so a crash loses at most the uncommitted part of each active piece.
const MAX_CHUNK = 16 * MB;
// Splitting a piece with less than this left isn't worth a new connection.
const MIN_SPLIT = 2 * MB;

// Job fields that only make sense while this document is alive.
const RUNTIME_KEYS = new Set([
  'session', 'active', 'samples', 'ctrl', 'running', 'blobUrl', 'dirty', 'dir', 'keys', 'writing',
]);
// What a job saved by an earlier session comes back as. Anything else
// (finished, canceled, failed) is cleaned up.
const RESTORED_STATUS = { downloading: 'downloading', paused: 'paused', saving: 'ready', ready: 'ready' };

class FatalError extends Error {}

const jobs = new Map();
const jobsRoot = navigator.storage.getDirectory().then((root) => root.getDirectoryHandle('jobs', { create: true }));

const toBackground = (type, extra) =>
  chrome.runtime.sendMessage({ target: 'background', type, ...extra }).catch(() => undefined);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chunkLength = (c) => c.end - c.start + 1;
const isComplete = (job, c) => (job.kind === 'hls' ? c.done : c.received >= chunkLength(c));
const receivedBytes = (job) => job.chunks.reduce((sum, c) => sum + c.received, 0);

function planChunks(size, connections) {
  const chunkSize = Math.min(MAX_CHUNK, Math.max(MB, Math.ceil(size / connections)));
  const chunks = [];
  for (let start = 0, index = 0; start < size; start += chunkSize, index++) {
    chunks.push({ index, start, end: Math.min(start + chunkSize, size) - 1 });
  }
  return chunks;
}

function hydrate(meta) {
  return {
    ...meta,
    chunks: meta.chunks.map((c) => ({ ...c, received: c.received ?? 0, claimed: false, inflight: 0 })),
    session: 0,
    active: 0,
    samples: [],
    ctrl: null,
    running: Promise.resolve(),
    blobUrl: null,
    dirty: false,
    dir: null,
    keys: new Map(),
  };
}

function createJob(spec) {
  const { segments, ...rest } = spec;
  const chunks = spec.kind === 'hls'
    ? segments.map((s, index) => ({ index, url: s.url, range: s.range, key: s.key, done: false }))
    : planChunks(spec.size, spec.connections);
  return hydrate({
    ...rest,
    status: 'downloading',
    error: null,
    createdAt: Date.now(),
    elapsedMs: 0,
    retries: 0,
    nextIndex: chunks.length,
    chunks,
  });
}

function persist(job) {
  job.dirty = false;
  const data = {};
  for (const [k, v] of Object.entries(job)) if (!RUNTIME_KEYS.has(k)) data[k] = v;
  data.chunks = job.chunks.map(({ claimed, inflight, ...c }) => c);
  const json = JSON.stringify(data);
  job.writing = (job.writing ?? Promise.resolve()).then(async () => {
    if (!job.dir) return;
    const writable = await (await job.dir.getFileHandle('meta.json', { create: true })).createWritable();
    await writable.write(json);
    await writable.close();
  }).catch(() => {});
  return job.writing;
}

async function restore() {
  const root = await jobsRoot;
  const handles = [];
  for await (const handle of root.values()) handles.push(handle);
  for (const dir of handles) {
    try {
      const meta = JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text());
      const status = RESTORED_STATUS[meta.status];
      if (!status) throw new Error('Nothing to restore');
      const job = hydrate({ ...meta, status });
      job.dir = dir;
      for (const c of job.chunks) {
        // Range pieces trust what is on disk; HLS segments are all or nothing.
        if (job.kind === 'range') c.received = await fileSize(dir, c.index);
        else if (!c.done) c.received = 0;
      }
      jobs.set(job.id, job);
    } catch {
      await root.removeEntry(dir.name, { recursive: true }).catch(() => {});
    }
  }
}

const fileSize = (dir, index) =>
  dir.getFileHandle(String(index)).then((h) => h.getFile()).then((f) => f.size, () => 0);

// Hands a worker its next piece. When none are left untouched, an idle
// connection takes the back half of the piece with the most still to fetch.
function nextChunk(job) {
  const free = job.chunks.find((c) => !c.claimed && !isComplete(job, c));
  if (free) {
    free.claimed = true;
    return free;
  }
  if (job.kind !== 'range') return null;

  let victim = null;
  let left = 0;
  for (const c of job.chunks) {
    const remaining = chunkLength(c) - c.received - c.inflight;
    if (c.claimed && remaining > left) {
      victim = c;
      left = remaining;
    }
  }
  if (!victim || left < MIN_SPLIT) return null;
  const start = victim.end - Math.floor(left / 2) + 1;
  const piece = { index: job.nextIndex++, start, end: victim.end, received: 0, claimed: true, inflight: 0 };
  victim.end = start - 1; // its worker sees the new end and stops there
  job.chunks.splice(job.chunks.indexOf(victim) + 1, 0, piece);
  persist(job);
  return piece;
}

function checkStatus(res, expected) {
  if (res.status === expected) return;
  const retryable = res.status === 429 || res.status >= 500;
  // A 200 to a range request means the file changed on the server
  // (If-Range failed) or the server stopped honouring ranges.
  throw new (retryable ? Error : FatalError)(
    `Server answered ${res.status}${expected === 206 ? ' to a range request' : ''}`);
}

async function withRetries(job, signal, attempt) {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      if (signal.aborted || e instanceof FatalError || n >= MAX_ATTEMPTS) throw e;
      job.retries++;
      await sleep(1000 * n);
    }
  }
}

// Feeds the body to onData until it ends or onData returns false.
async function readBody(res, onData) {
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || (await onData(value)) === false) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function fetchRange(job, chunk, signal) {
  const handle = await job.dir.getFileHandle(String(chunk.index), { create: true });
  await withRetries(job, signal, async () => {
    // Whatever reached disk before a pause, crash or dropped connection is
    // kept, so only the rest of the piece is requested.
    chunk.received = (await handle.getFile()).size;
    if (chunk.received >= chunkLength(chunk)) return;
    const headers = { Range: `bytes=${chunk.start + chunk.received}-${chunk.end}` };
    if (job.validator) headers['If-Range'] = job.validator;
    const res = await fetch(job.url, { headers, credentials: 'include', signal });
    checkStatus(res, 206);
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(chunk.received);
    job.active++;
    try {
      await readBody(res, async (data) => {
        // The end moves up if another connection split this piece.
        const left = chunkLength(chunk) - chunk.received;
        if (data.byteLength > left) data = data.subarray(0, left);
        chunk.inflight = data.byteLength;
        await writable.write(data);
        chunk.received += data.byteLength;
        chunk.inflight = 0;
        return chunk.received < chunkLength(chunk);
      });
    } finally {
      job.active--;
      chunk.inflight = 0;
      // Closing (rather than aborting) commits what was written so far.
      await writable.close().catch(() => {});
    }
    if (chunk.received < chunkLength(chunk)) throw new Error('Connection closed early');
  });
}

async function decrypt(job, key, data) {
  if (!job.keys.has(key.uri)) {
    const loading = fetch(key.uri, { credentials: 'include' })
      .then(async (res) => {
        checkStatus(res, 200);
        return crypto.subtle.importKey('raw', await res.arrayBuffer(), 'AES-CBC', false, ['decrypt']);
      })
      .catch((e) => {
        job.keys.delete(key.uri);
        throw e;
      });
    job.keys.set(key.uri, loading);
  }
  const iv = Uint8Array.from(key.iv.match(/../g), (byte) => parseInt(byte, 16));
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await job.keys.get(key.uri), data);
}

async function fetchSegment(job, segment, signal) {
  await withRetries(job, signal, async () => {
    segment.received = 0;
    const headers = segment.range ? { Range: `bytes=${segment.range[0]}-${segment.range[1]}` } : {};
    const res = await fetch(segment.url, { headers, credentials: 'include', signal });
    checkStatus(res, segment.range ? 206 : 200);
    const parts = [];
    job.active++;
    try {
      await readBody(res, (data) => {
        parts.push(data);
        segment.received += data.byteLength;
      });
    } finally {
      job.active--;
    }
    let data = await new Blob(parts).arrayBuffer();
    if (segment.key) data = await decrypt(job, segment.key, data);
    const writable = await (await job.dir.getFileHandle(String(segment.index), { create: true })).createWritable();
    await writable.write(data);
    await writable.close();
    segment.received = data.byteLength;
    segment.done = true;
    job.dirty = true;
  });
}

// One download session. Pausing aborts it; resuming starts a new one over
// whatever pieces are still incomplete.
async function run(job, session) {
  const ctrl = (job.ctrl = new AbortController());
  job.error = null;
  job.samples = [];
  for (const c of job.chunks) c.claimed = false;
  // Session rules are gone after a browser restart, so restate the Referer.
  await toBackground('rule', { jobId: job.id, url: job.url, referrer: job.referrer });

  const startedAt = Date.now();
  let failure = null;
  const fetchPiece = job.kind === 'hls' ? fetchSegment : fetchRange;
  const worker = async () => {
    for (let c; !ctrl.signal.aborted && (c = nextChunk(job));) await fetchPiece(job, c, ctrl.signal);
  };
  // allSettled so every worker has closed its file before the next session
  // (or cleanup) touches the same pieces.
  await Promise.allSettled(Array.from({ length: job.connections }, () =>
    worker().catch((e) => {
      failure ??= e;
      ctrl.abort();
    })));
  job.elapsedMs += Date.now() - startedAt;

  if (job.session !== session || job.status !== 'downloading') return; // paused or canceled
  if (failure) throw failure;
  await finish(job);
}

function startRun(job) {
  const session = ++job.session;
  job.status = 'downloading';
  persist(job);
  job.running = job.running
    .then(() => (job.session === session && job.status === 'downloading' ? run(job, session) : undefined))
    .catch(async (e) => {
      if (job.session !== session || !['downloading', 'saving'].includes(job.status)) return;
      job.status = 'error';
      job.error = e.message;
      await discard(job);
    });
}

async function finish(job) {
  job.status = 'saving';
  job.error = null;
  await persist(job);
  if (!job.blobUrl) {
    const files = await Promise.all(
      job.chunks.map((c) => job.dir.getFileHandle(String(c.index)).then((h) => h.getFile())),
    );
    job.blobUrl = URL.createObjectURL(new Blob(files, { type: job.mime || 'application/octet-stream' }));
  }
  const res = await toBackground('save', { jobId: job.id, blobUrl: job.blobUrl, filename: job.filename });
  if (!res || res.error) {
    job.status = 'ready';
    job.error = res?.error ?? 'Could not hand the file to Chrome';
    await persist(job);
  }
}

async function discard(job) {
  if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
  job.blobUrl = null;
  if (job.dir) {
    job.dir = null;
    await job.writing;
    await (await jobsRoot).removeEntry(String(job.id), { recursive: true }).catch(() => {});
  }
  await toBackground('finished', { jobId: job.id });
}

function view(job) {
  const received = receivedBytes(job);
  const segmentsDone = job.kind === 'hls' ? job.chunks.filter((c) => c.done).length : 0;
  const progress = job.kind === 'hls' ? segmentsDone / job.chunks.length : received / job.size;
  let speed = 0;
  let eta = 0;
  if (job.status === 'downloading' && job.samples.length > 1) {
    const first = job.samples[0];
    const last = job.samples[job.samples.length - 1];
    speed = (last.bytes - first.bytes) / ((last.t - first.t) / 1000);
    // HLS sizes are unknown up front, so extrapolate from segments done.
    const total = job.kind === 'hls' ? (progress ? received / progress : 0) : job.size;
    if (speed > 0 && total) eta = (total - received) / speed;
  } else if (job.elapsedMs) {
    speed = received / (job.elapsedMs / 1000);
  }
  return {
    id: job.id,
    kind: job.kind,
    filename: job.filename,
    url: job.url,
    size: job.size,
    received,
    progress,
    segments: job.kind === 'hls' ? [segmentsDone, job.chunks.length] : null,
    status: job.status,
    error: job.error,
    note: job.note ?? null,
    active: job.active,
    connections: job.connections,
    pieces: job.chunks.length,
    retries: job.retries,
    speed,
    eta,
    downloadId: job.downloadId ?? null,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.dirty) persist(job);
    if (job.status !== 'downloading') continue;
    // One-second samples over a five-second window give a steady speed.
    job.samples.push({ t: now, bytes: receivedBytes(job) });
    if (job.samples.length > 6) job.samples.shift();
  }
}, 1000);

const handlers = {
  async start({ job: spec }) {
    const job = createJob(spec);
    jobs.set(job.id, job);
    try {
      job.dir = await (await jobsRoot).getDirectoryHandle(String(job.id), { create: true });
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      return {};
    }
    startRun(job);
    return {};
  },
  list() {
    return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(view);
  },
  pause({ jobId }) {
    const job = jobs.get(jobId);
    if (job?.status === 'downloading') {
      job.status = 'paused';
      job.ctrl?.abort();
      persist(job);
    }
    return {};
  },
  resume({ jobId }) {
    const job = jobs.get(jobId);
    if (job?.status === 'paused') startRun(job);
    return {};
  },
  async cancel({ jobId }) {
    const job = jobs.get(jobId);
    if (!job) return {};
    job.status = 'canceled';
    job.ctrl?.abort();
    await job.running; // let the session close its files first
    await discard(job);
    return {};
  },
  async save({ jobId }) {
    const job = jobs.get(jobId);
    if (job?.status === 'ready') await finish(job).catch((e) => (job.error = e.message));
    return {};
  },
  async saved({ jobId, ok, downloadId }) {
    const job = jobs.get(jobId);
    if (!job) return {};
    if (ok) {
      job.status = 'done';
      job.downloadId = downloadId;
      await discard(job);
    } else {
      job.status = 'ready';
      job.error = 'Saving was interrupted. Click Save to try again.';
      await persist(job);
    }
    return {};
  },
  clear() {
    for (const [id, job] of jobs) {
      if (['done', 'error', 'canceled'].includes(job.status)) jobs.delete(id);
    }
    return {};
  },
};

// Messages wait for the restore, so a new job's folder can't be mistaken
// for a saved one.
const restored = restore().then(() => {
  for (const job of jobs.values()) if (job.status === 'downloading') startRun(job);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !handlers[msg.type]) return;
  restored
    .then(() => handlers[msg.type](msg))
    .then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});
