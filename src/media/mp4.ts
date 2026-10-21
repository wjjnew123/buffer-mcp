import { open } from "node:fs/promises";

export interface Mp4Info {
  width: number;
  height: number;
  durationMs: number;
  orientation: "portrait" | "landscape" | "square";
}

interface Box {
  type: string;
  start: number;
  end: number;
  dataStart: number;
}

const MAX_MOOV_BYTES = 256 * 1024 * 1024;

function readBoxHeader(buf: Buffer, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString("ascii", offset + 4, offset + 8);
  let dataStart = offset + 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    dataStart = offset + 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < dataStart - offset) return null;
  const end = Math.min(offset + size, limit);
  return { type, start: offset, end, dataStart };
}

function forEachBox(
  buf: Buffer,
  start: number,
  end: number,
  visit: (box: Box) => void,
): void {
  let offset = start;
  while (offset < end) {
    const box = readBoxHeader(buf, offset, end);
    if (!box) return;
    visit(box);
    if (box.end <= offset) return;
    offset = box.end;
  }
}

interface MoovInfo {
  durationMs: number;
  width: number;
  height: number;
}

function parseMvhd(buf: Buffer, box: Box): number {
  const p = box.dataStart;
  const version = buf.readUInt8(p);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    timescale = buf.readUInt32BE(p + 20);
    duration = Number(buf.readBigUInt64BE(p + 24));
  } else {
    timescale = buf.readUInt32BE(p + 12);
    duration = buf.readUInt32BE(p + 16);
  }
  if (!timescale) return 0;
  return Math.round((duration / timescale) * 1000);
}

function parseTrak(buf: Buffer, trak: Box): { width: number; height: number; isVideo: boolean } {
  let width = 0;
  let height = 0;
  let isVideo = false;

  forEachBox(buf, trak.dataStart, trak.end, (box) => {
    if (box.type === "tkhd") {
      if (box.end - box.start >= 8) {
        width = buf.readUInt32BE(box.end - 8) / 65536;
        height = buf.readUInt32BE(box.end - 4) / 65536;
      }
    } else if (box.type === "mdia") {
      forEachBox(buf, box.dataStart, box.end, (inner) => {
        if (inner.type === "hdlr") {
          const handler = buf.toString("ascii", inner.dataStart + 8, inner.dataStart + 12);
          if (handler === "vide") isVideo = true;
        }
      });
    }
  });

  return { width: Math.round(width), height: Math.round(height), isVideo };
}

function parseMoov(buf: Buffer, box: Box): MoovInfo {
  let durationMs = 0;
  const tracks: Array<{ width: number; height: number; isVideo: boolean }> = [];

  forEachBox(buf, box.dataStart, box.end, (child) => {
    if (child.type === "mvhd") {
      durationMs = parseMvhd(buf, child);
    } else if (child.type === "trak") {
      tracks.push(parseTrak(buf, child));
    }
  });

  const videoTracks = tracks.filter((t) => t.isVideo && t.width > 0 && t.height > 0);
  const pool = videoTracks.length ? videoTracks : tracks.filter((t) => t.width > 0 && t.height > 0);
  pool.sort((a, b) => b.width * b.height - a.width * a.height);
  const best = pool[0];

  return {
    durationMs,
    width: best?.width ?? 0,
    height: best?.height ?? 0,
  };
}

function orientationOf(width: number, height: number): Mp4Info["orientation"] {
  if (!width || !height) return "square";
  if (height > width) return "portrait";
  if (width > height) return "landscape";
  return "square";
}

export async function readMp4Info(filePath: string): Promise<Mp4Info | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const stat = await fh.stat();
    const fileSize = stat.size;

    let offset = 0;
    while (offset + 8 <= fileSize) {
      const head = Buffer.alloc(16);
      const { bytesRead } = await fh.read(head, 0, 16, offset);
      if (bytesRead < 8) break;

      let size = head.readUInt32BE(0);
      const type = head.toString("ascii", 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (bytesRead < 16) break;
        size = Number(head.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (size < headerSize) break;

      if (type === "moov") {
        if (size - headerSize > MAX_MOOV_BYTES) return null;
        const moovBuf = Buffer.alloc(size - headerSize);
        await fh.read(moovBuf, 0, moovBuf.length, offset + headerSize);
        const parsed = parseMoov(moovBuf, {
          type: "moov",
          start: 0,
          end: moovBuf.length,
          dataStart: 0,
        });
        return {
          ...parsed,
          orientation: orientationOf(parsed.width, parsed.height),
        };
      }

      offset += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export function orientationOfSize(width: number, height: number): Mp4Info["orientation"] {
  return orientationOf(width, height);
}
