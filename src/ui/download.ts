// ─── Store-only ZIP encoder + browser download (iframe-only) ───
//
// The Dev-Mode publish fallback: when there's no backend to write into Figma
// Variables, the plugin still helps by handing the user a folder of their Code
// Connect template files + contracts they can publish from the CLI. The main thread
// can't touch the filesystem, but the plugin UI iframe is a normal DOM context — a
// Blob + object URL + a synthetic `<a download>` click is the one path to disk. And
// a browser can't "download a folder", so we pack the files into a single ZIP.
//
// This is a dependency-free, store-only (compression method 0) encoder: no deflate,
// so it's ~80 lines and zips a handful of small text files instantly. The archive is
// a valid PKZIP a la `unzip`, macOS Archive Utility, and `figma connect` alike.

// CRC-32 (IEEE 802.3) — the checksum every ZIP entry carries. Table built once.
const CRC_TABLE: number[] = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  path: string // forward-slash path inside the archive
  text: string // UTF-8 file contents
}

// Little-endian byte helpers for the fixed-layout ZIP records.
const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

// A fixed, valid DOS timestamp (1980-01-01 00:00) — we don't stamp per-file mtimes,
// and a zero date makes some tools warn.
const DOS_TIME = 0
const DOS_DATE = 0x21

// Build a store-only ZIP from `entries`. Returns the archive bytes.
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const body: Uint8Array[] = [] // local headers + file data, in order
  const central: Uint8Array[] = [] // central-directory records
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc.encode(e.path)
    const dataBytes = enc.encode(e.text)
    const crc = crc32(dataBytes)
    const size = dataBytes.length

    const local = new Uint8Array(
      ([] as number[])
        .concat(u32(0x04034b50)) // local file header signature
        .concat(u16(20)) // version needed to extract (2.0)
        .concat(u16(0x0800)) // general-purpose flag: UTF-8 filename (bit 11)
        .concat(u16(0)) // compression method: store
        .concat(u16(DOS_TIME))
        .concat(u16(DOS_DATE))
        .concat(u32(crc))
        .concat(u32(size)) // compressed size (== uncompressed for store)
        .concat(u32(size)) // uncompressed size
        .concat(u16(nameBytes.length))
        .concat(u16(0)), // extra field length
    )
    body.push(local, nameBytes, dataBytes)

    central.push(
      new Uint8Array(
        ([] as number[])
          .concat(u32(0x02014b50)) // central directory header signature
          .concat(u16(20)) // version made by
          .concat(u16(20)) // version needed to extract
          .concat(u16(0x0800)) // general-purpose flag: UTF-8 filename
          .concat(u16(0)) // compression method: store
          .concat(u16(DOS_TIME))
          .concat(u16(DOS_DATE))
          .concat(u32(crc))
          .concat(u32(size))
          .concat(u32(size))
          .concat(u16(nameBytes.length))
          .concat(u16(0)) // extra field length
          .concat(u16(0)) // file comment length
          .concat(u16(0)) // disk number start
          .concat(u16(0)) // internal file attributes
          .concat(u32(0)) // external file attributes
          .concat(u32(offset)), // relative offset of local header
      ),
      nameBytes,
    )

    offset += local.length + nameBytes.length + dataBytes.length
  }

  const cdStart = offset
  let cdSize = 0
  for (const c of central) cdSize += c.length

  const eocd = new Uint8Array(
    ([] as number[])
      .concat(u32(0x06054b50)) // end of central directory signature
      .concat(u16(0)) // number of this disk
      .concat(u16(0)) // disk where the central directory starts
      .concat(u16(entries.length)) // central directory records on this disk
      .concat(u16(entries.length)) // total central directory records
      .concat(u32(cdSize))
      .concat(u32(cdStart))
      .concat(u16(0)), // comment length
  )

  const all = [...body, ...central, eocd]
  let total = 0
  for (const c of all) total += c.length
  const out = new Uint8Array(total)
  let p = 0
  for (const c of all) {
    out.set(c, p)
    p += c.length
  }
  return out
}

// Trigger a browser download of raw bytes as a named file. Wrapping the Uint8Array
// in a Blob + object URL and clicking a synthetic `<a download>` is the only way to
// reach disk from the sandboxed plugin — the main thread has no filesystem access.
export function downloadBytes(filename: string, bytes: Uint8Array, mime = 'application/zip'): void {
  // Cast around lib.dom's BlobPart wanting ArrayBufferView<ArrayBuffer> — a plain
  // Uint8Array is a valid BlobPart at runtime.
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next tick so the click has definitely started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
