import { describe, expect, test } from "vitest";
import { crc32, SimpleZipBuilder } from "./zip";

describe("SimpleZipBuilder", () => {
  test("computes correct crc32 for known strings", () => {
    const encoder = new TextEncoder();
    // Known standard CRC32 checksum for "123456789" is 0xcbf43926
    const data = encoder.encode("123456789");
    expect(crc32(data)).toBe(0xcbf43926);
  });

  test("builds a valid zip blob structure", async () => {
    const zip = new SimpleZipBuilder();
    const encoder = new TextEncoder();
    zip.addFile("test.txt", encoder.encode("Hello World!"));
    zip.addFile("frame_0001.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

    const blob = zip.buildBlob();
    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBeGreaterThan(0);

    const buffer = new Uint8Array(await blob.arrayBuffer());
    // Starts with local file header signature 0x04034b50 (little endian: 0x50, 0x4b, 0x03, 0x04)
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    expect(buffer[2]).toBe(0x03);
    expect(buffer[3]).toBe(0x04);
  });
});
