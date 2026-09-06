/**
 * Minimal zero-dependency ZIP archive builder (stored / uncompressed).
 *
 * PNG frames are already compressed with Deflate internally, so re-compressing
 * them in a ZIP with Deflate burns CPU for virtually 0% size benefit.
 * The standard ZIP format supports compression method 0 (STORE), which every
 * unarchiver (macOS Archive Utility, Windows Explorer, unzip, 7zip, Blender,
 * ffmpeg) handles natively.
 */

// Precomputed CRC32 table (IEEE 802.3 polynomial 0xedb88320)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

export class SimpleZipBuilder {
  private entries: ZipEntry[] = [];
  private encoder = new TextEncoder();

  addFile(name: string, data: Uint8Array): void {
    const nameBytes = this.encoder.encode(name);
    const crc = crc32(data);
    this.entries.push({
      name,
      nameBytes,
      data,
      crc,
      offset: 0,
    });
  }

  buildBlob(): Blob {
    const chunks: Uint8Array[] = [];
    let currentOffset = 0;

    // 1. Local File Headers + File Data
    for (const entry of this.entries) {
      entry.offset = currentOffset;
      const header = new Uint8Array(30 + entry.nameBytes.length);
      const view = new DataView(header.buffer);

      view.setUint32(0, 0x04034b50, true); // Local file header signature
      view.setUint16(4, 20, true); // Version needed to extract (2.0)
      view.setUint16(6, 0, true); // General purpose bit flag
      view.setUint16(8, 0, true); // Compression method (0 = STORE)
      view.setUint16(10, 0, true); // File mod time
      view.setUint16(12, 0, true); // File mod date
      view.setUint32(14, entry.crc, true); // CRC-32
      view.setUint32(18, entry.data.length, true); // Compressed size
      view.setUint32(22, entry.data.length, true); // Uncompressed size
      view.setUint16(26, entry.nameBytes.length, true); // File name length
      view.setUint16(28, 0, true); // Extra field length

      header.set(entry.nameBytes, 30);
      chunks.push(header);
      chunks.push(entry.data);

      currentOffset += header.length + entry.data.length;
    }

    const centralDirectoryStart = currentOffset;

    // 2. Central Directory Headers
    for (const entry of this.entries) {
      const cdHeader = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(cdHeader.buffer);

      view.setUint32(0, 0x02014b50, true); // Central directory header signature
      view.setUint16(4, 20, true); // Version made by (2.0)
      view.setUint16(6, 20, true); // Version needed to extract (2.0)
      view.setUint16(8, 0, true); // General purpose bit flag
      view.setUint16(10, 0, true); // Compression method (0 = STORE)
      view.setUint16(12, 0, true); // File mod time
      view.setUint16(14, 0, true); // File mod date
      view.setUint32(16, entry.crc, true); // CRC-32
      view.setUint32(20, entry.data.length, true); // Compressed size
      view.setUint32(24, entry.data.length, true); // Uncompressed size
      view.setUint16(28, entry.nameBytes.length, true); // File name length
      view.setUint16(30, 0, true); // Extra field length
      view.setUint16(32, 0, true); // File comment length
      view.setUint16(34, 0, true); // Disk number start
      view.setUint16(36, 0, true); // Internal file attributes
      view.setUint32(38, 0, true); // External file attributes
      view.setUint32(42, entry.offset, true); // Relative offset of local header

      cdHeader.set(entry.nameBytes, 46);
      chunks.push(cdHeader);

      currentOffset += cdHeader.length;
    }

    const centralDirectorySize = currentOffset - centralDirectoryStart;

    // 3. End of Central Directory Record (EOCD)
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);

    eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
    eocdView.setUint16(4, 0, true); // Number of this disk
    eocdView.setUint16(6, 0, true); // Disk where central directory starts
    eocdView.setUint16(8, this.entries.length, true); // Number of central directory records on this disk
    eocdView.setUint16(10, this.entries.length, true); // Total number of central directory records
    eocdView.setUint32(12, centralDirectorySize, true); // Size of central directory
    eocdView.setUint32(16, centralDirectoryStart, true); // Offset of start of central directory
    eocdView.setUint16(20, 0, true); // Comment length

    chunks.push(eocd);

    return new Blob(chunks as any[], { type: "application/zip" });
  }
}
