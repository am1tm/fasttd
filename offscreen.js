// Download engine. Splits a file into chunks, fetches them with N parallel
// workers, streams each chunk to its own file in the origin-private file
// system (so large downloads never sit in memory), then joins the chunk
// files into one Blob and asks the service worker to save it.

const MB = 1024 * 1024;
const MAX_ATTEMPTS = 5;

class FatalError extends Error {}

const jobs = new Map();

// Anything left in OPFS is from a previous session and can't be resumed.
const jobsDir = navigator.storage.getDirectory().then(async (root) => {
  await root.removeEntry('jobs', { recursive: true }).catch(() => {});
  return root.getDirectoryHandle('jobs', { create: true });
});

const toBackground = (type, extra) =>
  chrome.runtime.sendMessage({ target: 'background', type, ...extra }).catch(() => undefined);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chunkLength = (c) => c.end - c.start + 1;
const receivedBytes = (job) => job.chunks.reduce((sum, c) => sum + c.received, 0);

// Several chunks per connection so fast connections pick up the slack from
// slow ones (a work queue instead of IDM's segment splitting).
function planChunks(size, connections) {
  const chunkSize = Math.min(16 * MB, Math.max(MB, Math.ceil(size / (connections * 4))));
  const chunks = [];
  for (let start = 0, index = 0; start < size; start += chunkSize, index++) {
    chunks.push({ index, start, end: Math.min(start + chunkSize, size) - 1, received: 0 });
  }
  return chunks;
}

async function fetchChunk(job, chunk, signal) {
  const handle = await job.dir.getFileHandle(String(chunk.index), { create: true });
  for (let attempt = 1; ; attempt++) {
    // Whatever reached disk before a pause or a dropped connection is kept,
    // so only the rest of the chunk is requested.
    chunk.received = (await handle.getFile()).size;
    if (chunk.received >= chunkLength(chunk)) return;
    try {
      const headers = { Range: `bytes=${chunk.start + chunk.received}-${chunk.end}` };
      if (job.validator) headers['If-Range'] = job.validator;
      const res = await fetch(job.url, { headers, credentials: 'include', signal });
      if (res.status !== 206) {
        const retryable = res.status === 429 || res.status >= 500;
        // A 200 here means the file changed on the server (If-Range failed)
        // or the server stopped honouring ranges.
        throw new (retryable ? Error : FatalError)(`Server answered ${res.status} to a range request`);
      }
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.seek(chunk.received);
      const reader = res.body.getReader();
      job.active++;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          chunk.received += value.byteLength;
        }
      } finally {
        job.active--;
        reader.cancel().catch(() => {});
        // Closing (rather than aborting) commits what was written so far.
        await writable.close().catch(() => {});
      }
      if (chunk.received > chunkLength(chunk)) throw new FatalError('Server sent more data than requested');
      if (chunk.received < chunkLength(chunk)) throw new Error('Connection closed early');
      return;
    } catch (e) {
      if (signal.aborted || e instanceof FatalError || attempt >= MAX_ATTEMPTS) throw e;
      job.retries++;
      await sleep(1000 * attempt);
    }
  }
}

// One download session. Pausing aborts it; resuming starts a new one over
// whatever chunks are still incomplete.
async function run(job) {
  const ctrl = new AbortController();
  job.ctrl = ctrl;
  job.status = 'downloading';
  job.error = null;
  job.samples = [];
  const runStartedAt = Date.now();
  let failure = null;

  const pending = job.chunks.filter((c) => c.received < chunkLength(c));
  let next = 0;
  const worker = async () => {
    while (next < pending.length && !ctrl.signal.aborted) {
      await fetchChunk(job, pending[next++], ctrl.signal);
    }
  };
  // allSettled so every worker has closed its file before the next session
  // (or cleanup) touches the same chunks.
  await Promise.allSettled(
    Array.from({ length: Math.min(job.connections, pending.length) }, () =>
      worker().catch((e) => {
        failure ??= e;
        ctrl.abort();
      })),
  );
  job.elapsedMs += Date.now() - runStartedAt;

  if (job.status === 'paused') return;
  if (job.status === 'canceled' || failure) {
    if (job.status !== 'canceled') {
      job.status = 'error';
      job.error = failure.message;
    }
    await discard(job);
    return;
  }
  await save(job);
}

async function startJob(spec) {
  const job = {
    ...spec,
    status: 'downloading',
    error: null,
    active: 0,
    retries: 0,
    chunks: [],
    samples: [],
    startedAt: Date.now(),
    elapsedMs: 0,
    ctrl: new AbortController(),
    running: Promise.resolve(),
  };
  jobs.set(job.id, job);
  try {
    job.dir = await (await jobsDir).getDirectoryHandle(String(job.id), { create: true });
    job.chunks = planChunks(job.size, job.connections);
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    await discard(job);
    return;
  }
  job.running = run(job);
}

async function save(job) {
  job.status = 'saving';
  job.error = null;
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
  }
}

async function discard(job) {
  if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
  job.blobUrl = null;
  if (job.dir) {
    await (await jobsDir).removeEntry(String(job.id), { recursive: true }).catch(() => {});
    job.dir = null;
  }
  await toBackground('finished', { jobId: job.id });
}

function view(job) {
  const inProgress = job.status === 'downloading' || job.status === 'paused';
  let speed = 0;
  if (job.status === 'downloading' && job.samples.length > 1) {
    const first = job.samples[0];
    const last = job.samples[job.samples.length - 1];
    speed = (last.bytes - first.bytes) / ((last.t - first.t) / 1000);
  } else if (!inProgress && job.elapsedMs) {
    speed = job.size / (job.elapsedMs / 1000);
  }
  return {
    id: job.id,
    filename: job.filename,
    url: job.url,
    size: job.size,
    received: inProgress ? receivedBytes(job) : job.size,
    status: job.status,
    error: job.error,
    active: job.active,
    connections: job.connections,
    retries: job.retries,
    speed,
  };
}

// One-second samples over a five-second window give a steady speed readout.
setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status !== 'downloading') continue;
    job.samples.push({ t: now, bytes: receivedBytes(job) });
    if (job.samples.length > 6) job.samples.shift();
  }
}, 1000);

const handlers = {
  start({ job }) {
    startJob(job);
    return {};
  },
  list() {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(view);
  },
  pause({ jobId }) {
    const job = jobs.get(jobId);
    if (job?.status === 'downloading') {
      job.status = 'paused';
      job.ctrl.abort();
    }
    return {};
  },
  async resume({ jobId }) {
    const job = jobs.get(jobId);
    if (job?.status !== 'paused') return {};
    await job.running; // let the paused session finish closing its files
    if (job.status === 'paused') job.running = run(job);
    return {};
  },
  async cancel({ jobId }) {
    const job = jobs.get(jobId);
    if (!job) return {};
    const wasDownloading = job.status === 'downloading';
    job.status = 'canceled';
    job.ctrl.abort();
    // A running session cleans up after itself in run().
    if (!wasDownloading) {
      await job.running;
      await discard(job);
    }
    return {};
  },
  async save({ jobId }) {
    const job = jobs.get(jobId);
    if (job?.status === 'ready') await save(job);
    return {};
  },
  async saved({ jobId, ok }) {
    const job = jobs.get(jobId);
    if (!job) return {};
    if (ok) {
      job.status = 'done';
      await discard(job);
    } else {
      job.status = 'ready';
      job.error = 'Saving was interrupted. Click Save to try again.';
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !handlers[msg.type]) return;
  Promise.resolve(handlers[msg.type](msg)).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});
