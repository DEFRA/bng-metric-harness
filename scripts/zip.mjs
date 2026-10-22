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
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_SIZE = 22;
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

function localHeader(entry) {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAG_UTF8, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.body.length, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.nameBytes.length, 26);
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
  header.writeUInt32LE(CENTRAL_HEADER, 0);
  header.writeUInt16LE(MADE_BY_UNIX, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(FLAG_UTF8, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.body.length, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.nameBytes.length, 28);
  const unixMode = entry.directory ? UNIX_DIR_MODE : UNIX_FILE_MODE;
  const external =
    ((unixMode << UNIX_MODE_SHIFT) >>> 0) |
    (entry.directory ? MSDOS_DIRECTORY : 0);
  header.writeUInt32LE(external >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function endOfCentral(count, size, offset) {
  const end = Buffer.alloc(END_OF_CENTRAL_SIZE);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return end;
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
