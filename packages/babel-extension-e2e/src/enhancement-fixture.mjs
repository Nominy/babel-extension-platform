import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

function halveAmplitude(bytes, track) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) !== bytes.length - 8) fail('Invalid enhancement fixture RIFF');
  let format, data;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail('Truncated enhancement WAV chunk');
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.length) fail('Truncated enhancement WAV data');
    if (kind === 'fmt ') {
      if (format || size < 16) fail('Invalid enhancement WAV format count');
      format = { code: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10),
        rate: bytes.readUInt32LE(offset + 12), byteRate: bytes.readUInt32LE(offset + 16),
        align: bytes.readUInt16LE(offset + 20), bits: bytes.readUInt16LE(offset + 22) };
    } else if (kind === 'data') {
      if (data) fail('Ambiguous enhancement WAV data');
      data = bytes.subarray(offset + 8, end);
    }
    offset = end + (size & 1);
    if (offset > bytes.length) fail('Truncated enhancement WAV padding');
  }
  if (!format || !data || format.channels !== 1 || format.rate !== track.sampleRate
    || !((format.code === 1 && format.bits === 16) || (format.code === 3 && format.bits === 32))
    || format.align !== format.bits / 8 || format.byteRate !== format.rate * format.align
    || data.length !== track.frameCount * format.align) fail('Enhancement fixture source clock mismatch');
  const output = Buffer.alloc(44 + track.frameCount * 2);
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(track.sampleRate, 24); output.writeUInt32LE(track.sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36);
  output.writeUInt32LE(track.frameCount * 2, 40);
  for (let frame = 0; frame < track.frameCount; frame++) {
    const sample = format.code === 1 ? data.readInt16LE(frame * 2) / 32768 : data.readFloatLE(frame * 4);
    if (!Number.isFinite(sample)) fail('Nonfinite enhancement fixture PCM');
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 16384))), 44 + frame * 2);
  }
  return output;
}

/** Marked heavyweight inference boundary only; real multipart transport and byte verification. */
export async function enhancementFixtureResponse(payload, audioTracks) {
  if (!payload || typeof payload.taskId !== 'string' || !payload.taskId
    || typeof payload.model?.id !== 'string' || !/^[a-f0-9]{64}$/.test(payload.model?.sha256 ?? '')
    || !Array.isArray(payload.tracks) || payload.tracks.length !== 2
    || new Set(payload.tracks.map(track => track.trackId)).size !== 2 || audioTracks.length !== 2) fail('Invalid enhancement fixture request');
  const outputs = [];
  for (const [index, track] of payload.tracks.entries()) {
    if (track.fieldName !== `audio:${index + 1}` || typeof track.trackId !== 'string' || !track.trackId
      || typeof track.speakerKey !== 'string' || typeof track.trackLabel !== 'string'
      || !Number.isSafeInteger(track.sampleRate) || track.sampleRate <= 0 || track.sampleRate > 192000
      || !Number.isSafeInteger(track.frameCount) || track.frameCount <= 0
      || track.frameCount * 2 > 32 * 1024 * 1024) fail('Invalid enhancement fixture track');
    const source = audioTracks.find(source => source.fieldName === track.fieldName);
    if (!source) fail('Enhancement fixture lane is missing');
    const input = Buffer.from(await source.blob.arrayBuffer());
    if (sha256(input) !== track.sourceSha256) fail('Enhancement fixture source SHA-256 mismatch');
    const bytes = halveAmplitude(input, track);
    outputs.push({ bytes, metadata: {
      trackId: track.trackId, speakerKey: track.speakerKey, trackLabel: track.trackLabel,
      mimeType: 'audio/wav', sampleRate: track.sampleRate, frameCount: track.frameCount,
      sourceSha256: track.sourceSha256, wavSha256: sha256(bytes), totalBytes: bytes.length,
      chunkCount: Math.ceil(bytes.length / 524288),
    } });
  }
  const form = new FormData();
  form.append('result', JSON.stringify({ ok: true, provider: 'swarm', taskId: payload.taskId,
    model: payload.model.id, modelSha256: payload.model.sha256, tracks: outputs.map(output => output.metadata) }));
  for (const [index, output] of outputs.entries()) {
    form.append(`audio:${index + 1}`, new Blob([output.bytes], { type: 'audio/wav' }), `e2e-half-amplitude-${index + 1}.wav`);
  }
  const response = new Response(form);
  return { contentType: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()),
    tracks: outputs.map(output => output.metadata) };
}
