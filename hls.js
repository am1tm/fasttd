// HLS (.m3u8) support: turns a playlist into the list of segments to fetch.
// Segments are joined back to back, which gives a playable .ts file, or an
// .mp4 when the stream uses fragmented MP4 with an init segment.

export const isHlsUrl = (url) => /\.m3u8($|[?#])/i.test(url);
export const isHlsMime = (mime) => /mpegurl/i.test(mime);

const attributes = (text) =>
  Object.fromEntries([...text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')]));

function byteRange(spec, defaultStart) {
  if (!spec) return null;
  const [length, offset] = spec.split('@');
  const start = offset != null ? Number(offset) : defaultStart;
  return [start, start + Number(length) - 1];
}

// fetchText(url) resolves to { text, finalUrl }.
export async function loadHls(url, fetchText) {
  let { text, finalUrl } = await fetchText(url);
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');

  let separateAudio = false;
  if (text.includes('#EXT-X-STREAM-INF')) {
    // A master playlist: pick the highest-bandwidth variant.
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    let best = null;
    lines.forEach((line, i) => {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) return;
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
      const attrs = attributes(line.slice(18));
      const bandwidth = Number(attrs.BANDWIDTH) || 0;
      if (uri && (!best || bandwidth > best.bandwidth)) {
        best = { bandwidth, url: new URL(uri, finalUrl).href, audio: attrs.AUDIO };
      }
    });
    if (!best) throw new Error('Playlist has no playable variants');
    separateAudio = Boolean(best.audio) && lines.some((l) =>
      l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l) && /URI=/.test(l) && l.includes(`"${best.audio}"`));
    ({ text, finalUrl } = await fetchText(best.url));
  }
  return { ...parseMediaPlaylist(text, finalUrl), separateAudio };
}

export function parseMediaPlaylist(text, base) {
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error("Live streams can't be downloaded");
  const segments = [];
  let mediaSequence = 0;
  let key = null;
  let init = null;
  let pendingRange = null;
  let lastRangeEnd = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line.slice(11));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { uri: new URL(a.URI, base).href, iv: a.IV?.replace(/^0x/i, '') ?? null };
      else throw new Error(`${a.METHOD} encrypted (DRM) streams aren't supported`);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line.slice(11));
      const map = { url: new URL(a.URI, base).href, range: byteRange(a.BYTERANGE, 0) };
      if (init && (init.url !== map.url || String(init.range) !== String(map.range))) {
        throw new Error('Streams that switch init segments midway aren\'t supported');
      }
      init = map;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17);
    } else if (!line.startsWith('#')) {
      let range = null;
      if (pendingRange) {
        range = byteRange(pendingRange, lastRangeEnd);
        lastRangeEnd = range[1] + 1;
        pendingRange = null;
      }
      const sequence = mediaSequence + segments.length;
      segments.push({
        url: new URL(line, base).href,
        range,
        // Without an explicit IV, the segment's sequence number is the IV.
        key: key && { uri: key.uri, iv: (key.iv ?? sequence.toString(16)).padStart(32, '0') },
      });
    }
  }
  if (!segments.length) throw new Error('Playlist has no segments');
  if (init) segments.unshift({ url: init.url, range: init.range, key: null });
  return { segments, container: init ? 'mp4' : 'ts' };
}
