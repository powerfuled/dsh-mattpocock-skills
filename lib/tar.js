import { gunzipSync, gzipSync } from 'node:zlib';

import { isSafeRelativePath, stripComponents } from './util.js';

const BLOCK_SIZE = 512;

const DEFAULT_LIMITS = {
  maxFiles: 5000,
  maxFileSize: 4 * 1024 * 1024,
  maxTotalSize: 96 * 1024 * 1024,
};

function readCString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const limit = offset + length;
  const stop = end === -1 || end > limit ? limit : end;
  return buffer.toString('utf8', offset, stop).trim();
}

function parseNumericField(buffer, offset, length) {
  const first = buffer[offset];
  if ((first & 0x80) !== 0) {
    // GNU base-256 extension: the high bit of the first byte is the sign flag.
    let value = first & 0x7f;
    for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i];
    return value;
  }
  const raw = buffer.toString('ascii', offset, offset + length).replace(/\0/g, '').trim();
  if (raw === '') return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function isZeroBlock(buffer, offset) {
  for (let i = offset; i < offset + BLOCK_SIZE; i += 1) {
    if (buffer[i] !== 0) return false;
  }
  return true;
}

function readPaxPath(text) {
  // PAX records are `"<length> <key>=<value>\n"` sequences.
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
  if (match) return match[1];
  const loose = /(?:^|\n)path=([^\n]*)\n/.exec(text);
  return loose ? loose[1] : undefined;
}

function roundUp(size) {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

/**
 * Extract a gzipped tar archive in memory.
 *
 * Handles ustar prefix fields plus GNU long names (`L`) and PAX headers (`x`/`g`).
 * Directories, symlinks and other non-regular entries are skipped, and every
 * accepted path is validated as a safe relative path.
 *
 * @param {Buffer|Uint8Array} gzBuffer raw `.tar.gz` bytes.
 * @param {{ stripComponents?: number, filter?: (path: string) => boolean, maxFiles?: number, maxFileSize?: number, maxTotalSize?: number }} [options]
 * @returns {{ path: string, size: number, mode: number, data: Buffer }[]}
 */
export function extractTarGz(gzBuffer, options = {}) {
  const strip = options.stripComponents ?? 0;
  const filter = options.filter;
  const maxFiles = options.maxFiles ?? DEFAULT_LIMITS.maxFiles;
  const maxFileSize = options.maxFileSize ?? DEFAULT_LIMITS.maxFileSize;
  const maxTotalSize = options.maxTotalSize ?? DEFAULT_LIMITS.maxTotalSize;

  const tar = gunzipSync(gzBuffer);
  const entries = [];

  let offset = 0;
  let fileCount = 0;
  let totalSize = 0;
  let pendingLongName;
  let pendingPaxPath;

  while (offset + BLOCK_SIZE <= tar.length) {
    if (isZeroBlock(tar, offset)) break;

    const headerStart = offset;
    const size = parseNumericField(tar, headerStart + 124, 12);
    if (!Number.isFinite(size) || size < 0) throw new Error('tar: invalid entry size');
    const typeflag = String.fromCharCode(tar[headerStart + 156] || 0x30);

    const dataStart = headerStart + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('tar: truncated archive');
    offset = dataStart + roundUp(size);

    let name = readCString(tar, headerStart, 100);
    const prefix = readCString(tar, headerStart + 345, 155);
    if (prefix !== '') name = `${prefix}/${name}`;
    if (pendingLongName !== undefined) {
      name = pendingLongName;
      pendingLongName = undefined;
    }
    if (pendingPaxPath !== undefined) {
      name = pendingPaxPath;
      pendingPaxPath = undefined;
    }

    if (typeflag === 'L') {
      pendingLongName = readCString(tar, dataStart, size) || tar.toString('utf8', dataStart, dataEnd).trim();
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const text = tar.toString('utf8', dataStart, dataEnd);
      const paxPath = readPaxPath(text);
      if (paxPath !== undefined && typeflag === 'x') pendingPaxPath = paxPath;
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') continue;

    const relative = stripComponents(name, strip);
    if (relative === undefined) continue;
    if (!isSafeRelativePath(relative)) continue;
    if (typeof filter === 'function' && !filter(relative)) continue;

    fileCount += 1;
    if (fileCount > maxFiles) throw new Error(`tar: archive exceeds ${maxFiles} entries`);
    if (size > maxFileSize) continue;
    totalSize += size;
    if (totalSize > maxTotalSize) throw new Error('tar: archive exceeds the extracted-size budget');

    entries.push({
      path: relative,
      size,
      mode: parseNumericField(tar, headerStart + 100, 8),
      data: Buffer.from(tar.subarray(dataStart, dataEnd)),
    });
  }

  return entries;
}

function writeString(header, offset, length, value) {
  Buffer.from(String(value), 'utf8').copy(header, offset, 0, length);
}

/** Assemble one ustar header block. */
function buildHeader({ name, prefix = '', size = 0, type = '0', mtime }) {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, '0000644\0');
  writeString(header, 108, 8, '0000000\0');
  writeString(header, 116, 8, '0000000\0');
  writeString(header, 124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  writeString(header, 136, 12, `${mtime.toString(8).padStart(11, '0')}\0`);
  writeString(header, 148, 8, '        ');
  writeString(header, 156, 1, type);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  if (prefix !== '') writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/**
 * Fit a path into the ustar name/prefix pair, or return undefined when the
 * path cannot be represented (the caller then emits a GNU long-name entry).
 */
function splitUstarName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const parts = path.split('/');
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  return undefined;
}

/**
 * Build a gzipped tar archive from `{ path, data }` entries.
 *
 * Mirrors what `codeload.github.com` produces: paths that do not fit the ustar
 * name/prefix pair are preceded by a GNU long-name (`L`) entry. Used by the
 * test suite and by fixture generation; not part of the runtime sync path.
 */
export function createTarGz(files, { mtime = 1700000000 } = {}) {
  const chunks = [];
  for (const file of files) {
    const path = String(file.path);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf8');
    const type = file.type ?? '0';
    const split = splitUstarName(path);

    if (split === undefined) {
      const longData = Buffer.from(`${path}\0`, 'utf8');
      chunks.push(buildHeader({ name: 'longname', size: longData.length, type: 'L', mtime }), longData);
      const longPadding = roundUp(longData.length) - longData.length;
      if (longPadding > 0) chunks.push(Buffer.alloc(longPadding));
      chunks.push(buildHeader({ name: path.slice(0, 100), size: data.length, type, mtime }), data);
    } else {
      chunks.push(buildHeader({ ...split, size: data.length, type, mtime }), data);
    }

    const padding = roundUp(data.length) - data.length;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(chunks));
}

