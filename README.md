# <img src="icons/icon-128.png" width="32" align="top"> fasttD

A Chrome extension that speeds up downloads the way Internet Download Manager does. It splits a file into byte ranges and downloads them in parallel.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin fasttD from the puzzle-piece menu.

## Use

- **Auto-capture** (on by default): when a download starts, fasttD checks whether the server supports range requests. If it does and the file is over the size threshold, fasttD takes the download over. If not, Chrome's own download keeps going untouched.
- **Right-click a link** and pick **Download with fasttD**.
- **Paste a link** into the popup, including `.m3u8` stream links.
- **Grab media from a page:** play a video or song, open fasttD and pick it under **This page**. Plain files (MP4, WebM, MP3, …) and HLS streams are detected. HLS streams are saved as a single `.ts` or `.mp4`.

The popup shows progress, speed, active connections and ETA, and lets you pause, resume or cancel each download. Once all the pieces are in, fasttD hands the file to Chrome, so it lands in your normal Downloads folder and shows up in `chrome://downloads`.

## How it works

| File | Role |
| --- | --- |
| `background.js` | Watches downloads, sends a 1-byte `Range` probe, spots media on pages, cancels Chrome's copy, hands finished files to `chrome.downloads` |
| `offscreen.js` | The engine: N parallel `fetch` workers stream pieces into the origin-private file system, then the pieces are joined into one Blob |
| `hls.js` | Parses `.m3u8` playlists (best variant, AES-128 keys, fMP4 init segments, byte ranges) |
| `popup.*` | UI and settings |
| `tools/make_icons.py` | Renders `icons/*.png` (`python3 tools/make_icons.py`) |

- Chunks go to disk as they stream in, so multi-GB files don't fill up RAM.
- **Dynamic splitting:** when a connection runs out of work, it takes the back half of the piece with the most left, so slow connections don't hold up the finish.
- **Survives restarts:** each download keeps a `meta.json` beside its pieces. After a browser restart, crash or extension update, unfinished downloads come back and continue.
- Pausing keeps every byte already on disk; resuming (or retrying after a dropped connection, up to 5 times) requests only the rest of each chunk.
- `If-Range` with the ETag/Last-Modified stops a file that changes mid-download from being stitched together wrong.
- The page's `Referer` is forwarded through a scoped `declarativeNetRequest` rule, since some hosts require it.

## Limits worth knowing

- **The speedup depends on the server.** Parallel connections help when a server or CDN throttles each connection. If your line is already maxed out, nothing gets faster.
- **Chrome limits connections.** HTTP/1.1 allows 6 connections per host, which is why 6 is the default. HTTP/2 and HTTP/3 servers multiplex every request over one connection. That still gets past per-request throttling, but not past per-connection throttling.
- **A crash can lose a little progress.** Pieces are committed to disk when a connection finishes, pauses or drops, so a hard crash loses the uncommitted part of each active piece (at most 16 MB each).
- **Long pauses can outlive signed download links**, which then fail on resume.
- **Streams:** live streams, DRM (SAMPLE-AES, Widevine and friends), DASH and YouTube aren't supported. Some HLS streams keep audio in a separate track; fasttD warns when it sees one, since the saved video may be silent.
- **Disk usage briefly doubles** while the joined file is saved (temporary pieces plus the final copy).
- **Not every download can be taken over.** POST-form downloads and one-time signed URLs fail the probe, and fasttD leaves those to Chrome.
- Chrome has a built-in experimental version of this: `chrome://flags/#enable-parallel-downloading`.
