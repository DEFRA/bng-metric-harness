/**
 * A minimal zip writer, so the harness can hand over a folder as one file
 * without a dependency: each file deflated (or stored, if deflating does not
 * shrink it), with the folder's own name as the top-level entry, as a
 * desktop "compress" gives. Enough for a QGIS template folder; no zip64, so
 * each file and the whole archive must stay under 4 GiB.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UINT16_BYTES = 2;
const UINT32_BYTES = 4;
const VERSION_NEEDED = 20;
// Bit 11: names are UTF-8, so spaces and accents survive on every platform.
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const MAX_ZIP_SIZE = 0xffffffff;
const MAX_ENTRIES = 0xffff;
// MS-DOS date and time fields, which zip entries carry.
const DOS_EPOCH_YEAR = 1980;
const DOS_YEAR_SHIFT = 9;
const DOS_MONTH_SHIFT = 5;
const DOS_HOUR_SHIFT = 11;
const DOS_MINUTE_SHIFT = 5;
const DOS_SECONDS_STEP = 2;
// Unix permissions in the high half of the external attributes: rw-r--r--
// for a file, rwxr-xr-x for a folder.
const UNIX_FILE_MODE = 0o100644;
const UNIX_DIR_MODE = 0o040755;
const UNIX_MODE_SHIFT = 16;
const MSDOS_DIRECTORY = 0x10;
const MADE_BY_UNIX = 0x0314;

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), DOS_EPOCH_YEAR) - DOS_EPOCH_YEAR;
  return {
    time:
      (date.getHours() << DOS_HOUR_SHIFT) |
      (date.getMinutes() << DOS_MINUTE_SHIFT) |
      Math.floor(date.getSeconds() / DOS_SECONDS_STEP),
    date:
      (year << DOS_YEAR_SHIFT) |
      ((date.getMonth() + 1) << DOS_MONTH_SHIFT) |
      date.getDate(),
  };
}

/**
 * By code point, as the same on every machine, so a folder always zips in
 * the same order; localeCompare would follow the machine's locale.
 */
function codePointOrder(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Every file and folder under `dir`, as zip names, each folder first. */
function entriesUnder(dir, prefix) {
  const entries = [{ name: `${prefix}/`, file: null }];
  const names = readdirSync(dir).sort(codePointOrder);
  for (const name of names) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...entriesUnder(full, `${prefix}/${name}`));
    } else {
      entries.push({ name: `${prefix}/${name}`, file: full });
    }
  }
  return entries;
}

function compressed(data) {
  const deflated = deflateRawSync(data);
  return deflated.length < data.length
    ? { method: METHOD_DEFLATED, body: deflated }
    : { method: METHOD_STORED, body: data };
}

/**
 * Little-endian fields, in order, as one buffer: each `[bytes, value]`, two
 * or four bytes wide. Writing a header field by field keeps its layout in
 * the order the zip format lists it, with no offsets to keep in step.
 */
function fields(list) {
  const buffer = Buffer.alloc(list.reduce((n, [bytes]) => n + bytes, 0));
  let offset = 0;
  for (const [bytes, value] of list) {
    if (bytes === UINT16_BYTES) {
      buffer.writeUInt16LE(value, offset);
    } else {
      buffer.writeUInt32LE(value >>> 0, offset);
    }
    offset += bytes;
  }
  return buffer;
}

const u16 = (value) => [UINT16_BYTES, value];
const u32 = (value) => [UINT32_BYTES, value];
const NONE = 0;

/** The fields a local header and its central-directory entry share. */
function sharedFields(entry) {
  return [
    u16(VERSION_NEEDED),
    u16(FLAG_UTF8),
    u16(entry.method),
    u16(entry.time),
    u16(entry.date),
    u32(entry.crc),
    u32(entry.body.length),
    u32(entry.size),
    u16(entry.nameBytes.length),
    u16(NONE), // extra field length
  ];
}

function localHeader(entry) {
  return fields([u32(LOCAL_HEADER), ...sharedFields(entry)]);
}

function centralHeader(entry) {
  const unixMode = entry.directory ? UNIX_DIR_MODE : UNIX_FILE_MODE;
  const external =
    ((unixMode << UNIX_MODE_SHIFT) >>> 0) |
    (entry.directory ? MSDOS_DIRECTORY : 0);
  return fields([
    u32(CENTRAL_HEADER),
    u16(MADE_BY_UNIX),
    ...sharedFields(entry),
    u16(NONE), // file comment length
    u16(NONE), // disk number start
    u16(NONE), // internal attributes
    u32(external),
    u32(entry.offset),
  ]);
}

function endOfCentral(count, size, offset) {
  return fields([
    u32(END_OF_CENTRAL),
    u16(NONE), // this disk
    u16(NONE), // disk where the central directory starts
    u16(count), // entries on this disk
    u16(count), // entries in all
    u32(size),
    u32(offset),
    u16(NONE), // comment length
  ]);
}

/**
 * Zip the folder `dir` into `zipPath`, its contents under one top-level
 * folder of the same name.
 *
 * @param {string} dir
 * @param {string} zipPath
 * @param {{ date?: Date }} [options]  the time each entry records (now by
 *   default); a fixed date gives the same bytes for the same files
 * @returns {string} zipPath
 */
export function zipFolder(dir, zipPath, { date = new Date() } = {}) {
  const stamp = dosDateTime(date);
  const parts = [];
  const written = [];
  let offset = 0;
  const listed = entriesUnder(dir, path.basename(dir));
  if (listed.length > MAX_ENTRIES) {
    throw new Error(`${dir}: too many files to zip (${listed.length})`);
  }
  for (const { name, file } of listed) {
    const data = file ? readFileSync(file) : Buffer.alloc(0);
    const { method, body } = file
      ? compressed(data)
      : { method: METHOD_STORED, body: data };
    const entry = {
      ...stamp,
      nameBytes: Buffer.from(name, "utf8"),
      method,
      body,
      size: data.length,
      crc: crc32(data),
      offset,
      directory: !file,
    };
    const header = localHeader(entry);
    parts.push(header, entry.nameBytes, body);
    offset += header.length + entry.nameBytes.length + body.length;
    written.push(entry);
  }
  const centralStart = offset;
  for (const entry of written) {
    const header = centralHeader(entry);
    parts.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }
  if (offset > MAX_ZIP_SIZE) {
    throw new Error(`${dir}: too large to zip without zip64`);
  }
  parts.push(endOfCentral(written.length, offset - centralStart, centralStart));
  writeFileSync(zipPath, Buffer.concat(parts));
  return zipPath;
}
