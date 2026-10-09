import { requireThat } from './errors.mjs';

export function checkContentType(value, kind) {
  const type = (value || '').split(';')[0].trim().toLowerCase();
  const generic = !type || ['application/octet-stream', 'binary/octet-stream', 'application/ogg'].includes(type);
  requireThat(generic || type.startsWith(`${kind}/`), 'invalid_download_content',
    'The file service did not return the expected media. Keep the task ID and retry the download; do not regenerate.', { expected_kind: kind, content_type: type });
  return type;
}

// Inspect a bounded prefix, without decoding or modifying the original media.
export function checkMediaPrefix(bytes, kind, contentType) {
  const ascii = (offset, length) => bytes.toString('ascii', offset, offset + length);
  let kinds = [];
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) || ascii(0, 2) === 'BM' ||
      ['49492a00', '4d4d002a', '00000100'].includes(bytes.subarray(0, 4).toString('hex'))) kinds = ['image'];
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') kinds = ['image'];
  else if ((ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') ||
      (ascii(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(8, 4))) ||
      ascii(0, 4) === 'fLaC' || ascii(0, 3) === 'ID3' ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) kinds = ['audio'];
  else if (ascii(0, 4) === 'OggS' || bytes.subarray(0, 4).toString('hex') === '1a45dfa3') kinds = ['audio', 'video'];
  else if (ascii(4, 4) === 'ftyp') {
    kinds = ['avif', 'avis', 'heic', 'heix', 'heif', 'mif1', 'msf1'].includes(ascii(8, 4)) ? ['image'] : ['audio', 'video'];
  } else if (bytes.subarray(0, 4).toString('hex') === '000001ba') kinds = ['video'];
  else if (contentType === 'image/svg+xml' && /^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart())) kinds = ['image'];
  requireThat(kinds.includes(kind), 'invalid_download_content',
    'The response has no matching media header. It may be an error page or an incomplete file. Keep the task ID and retry the download; do not regenerate.', { expected_kind: kind });
}
