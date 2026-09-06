import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, isAbsolute } from 'node:path';

function assert(value, message) { if (!value) throw new Error(`Speech fixture: ${message}`); }
async function containedFile(root, relative) {
  assert(typeof relative === 'string' && relative && !isAbsolute(relative) && !relative.includes(':') && !relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'paths must be simple relative paths inside the configured directory');
  const path = await realpath(resolve(root, relative));
  assert(path.startsWith(root + sep), 'path resolves outside the configured directory');
  const info = await stat(path);
  assert(info.isFile() && info.size <= 64 * 1024 * 1024, 'file must be a regular file no larger than 64 MiB');
  return readFile(path);
}
export function wavInfo(bytes) {
  assert(bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE', 'tracks must be RIFF WAVE files');
  assert(bytes.readUInt32LE(4) + 8 === bytes.length, 'RIFF declared length must equal file length');
  let format, dataBytes;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    assert(start + length <= bytes.length, 'WAV chunk exceeds file length');
    if (id === 'fmt ') {
      assert(length >= 16, 'WAV fmt chunk is incomplete');
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    }
    if (id === 'data') dataBytes = length;
    offset = start + length + (length % 2);
  }
  assert(format?.encoding === 1 && format.channels === 1 && format.bits === 16 && format.blockAlign === 2, 'tracks must be mono PCM16 WAV');
  assert(format.sampleRate >= 8000 && format.sampleRate <= 192000 && format.byteRate === format.sampleRate * 2, 'invalid WAV sample rate or byte rate');
  assert(dataBytes > 0 && dataBytes % 2 === 0, 'WAV must have complete nonempty PCM samples');
  return { sampleRate: format.sampleRate, duration: dataBytes / format.byteRate };
}
function annotations(value, duration, label) {
  assert(Array.isArray(value) && value.length > 0, `${label} must be a nonempty array`);
  const ids = new Set();
  for (const row of value) {
    assert(typeof row.id === 'string' && row.id && !ids.has(row.id), `${label} IDs must be nonempty and unique`); ids.add(row.id);
    assert(['speaker-1', 'speaker-2'].includes(row.processedRecordingId), `${label} processedRecordingId must be speaker-1 or speaker-2`);
    assert(typeof row.content === 'string' && row.content.trim(), `${label} content must be nonempty text`);
    assert(Number.isFinite(row.startTimeInSeconds) && Number.isFinite(row.endTimeInSeconds) && row.startTimeInSeconds >= 0 && row.endTimeInSeconds > row.startTimeInSeconds && row.endTimeInSeconds <= duration, `${label} timestamps must lie inside the WAV duration`);
  }
  return value;
}

/** Explicit local input only. Nothing is copied into the reproducible sanitized snapshot. */
export async function loadSpeechFixtures(directory) {
  if (!directory) return null;
  const root = await realpath(resolve(directory));
  const manifest = JSON.parse((await containedFile(root, 'manifest.json')).toString('utf8'));
  assert(manifest.schema === 'babel-e2e-speech-v1', 'manifest.schema must be babel-e2e-speech-v1');
  assert(Array.isArray(manifest.tracks) && manifest.tracks.length === 2 && new Set(manifest.tracks.map((track) => track.speaker)).size === 2 && manifest.tracks.every((track) => [1, 2].includes(track.speaker)), 'manifest.tracks must contain speakers 1 and 2 exactly once');
  const tracks = await Promise.all(manifest.tracks.map(async (track) => {
    const bytes = await containedFile(root, track.path); return { speaker: track.speaker, bytes, ...wavInfo(bytes) };
  }));
  assert(tracks[0].sampleRate === tracks[1].sampleRate && Math.abs(tracks[0].duration - tracks[1].duration) < 1 / tracks[0].sampleRate, 'both lanes must have the same sample rate and duration');
  return { tracks: new Map(tracks.map((track) => [track.speaker, track.bytes])), sampleRate: tracks[0].sampleRate, duration: tracks[0].duration,
    annotations: annotations(manifest.annotations, tracks[0].duration, 'annotations'),
    referenceAnnotations: manifest.referenceAnnotations ? annotations(manifest.referenceAnnotations, tracks[0].duration, 'referenceAnnotations') : null };
}
