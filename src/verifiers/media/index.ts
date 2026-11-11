import { inspectMedia } from "../../core/media.js";
import { defineVerifier, type Check } from "../../core/verifier.js";

const MIN_BYTES = { audio: 2048, video: 8192, image: 1024 } as const;
const MIN_IMAGE_SIDE = 320;
const MIN_SECONDS = 1;
const TOLERANCE_SECONDS = 1;

/** Media files are what they claim, not stubs, not longer than the task allows, images not tiny. */
export const media = defineVerifier({
  id: "media",
  name: "Media basics",
  description:
    "Each file's bytes match its declared type, it is big enough to be real, clips stay within the task's time limit, and images are not thumbnails. Durations and sizes come from the container, so unreadable formats answer uncertain.",
  applies: { media: ["audio", "video", "image"] },
  deterministic: true,
  verify({ job, work }) {
    const checks: Check[] = [];
    const maxSeconds = job.requirements?.files?.max_seconds;
    let uncertain = false;
    let accepted = 0;
    for (const piece of work) {
      if (piece.kind !== "file") {
        accepted += 1;
        continue;
      }
      let ok = true;
      const info = inspectMedia(piece.bytes, piece.name, piece.mime_type);
      const declaredKind = inspectMedia(new Uint8Array(0), undefined, piece.mime_type).kind;
      if (info.mime && piece.mime_type && declaredKind !== "other" && info.kind !== declaredKind) {
        checks.push({
          id: "type",
          ok: false,
          file: piece.name,
          message: `${piece.name} says ${piece.mime_type} but its bytes are ${info.mime}`,
        });
        ok = false;
      }
      const floor = info.kind === "audio" || info.kind === "video" || info.kind === "image" ? MIN_BYTES[info.kind] : 0;
      if (floor && piece.bytes.byteLength < floor) {
        checks.push({
          id: "min_size",
          ok: false,
          file: piece.name,
          message: `${piece.name} is ${piece.bytes.byteLength} bytes, too small to be a real ${info.kind}`,
        });
        ok = false;
      }
      if (info.kind === "audio" || info.kind === "video") {
        if (info.duration_seconds === undefined) {
          checks.push({
            id: "duration",
            ok: true,
            file: piece.name,
            message: `${piece.name}: duration not readable from a ${info.mime ?? "unknown"} container; a person should check the length`,
            details: { readable: false },
          });
          uncertain = true;
        } else {
          const seconds = Math.round(info.duration_seconds * 10) / 10;
          if (info.duration_seconds < MIN_SECONDS) {
            checks.push({
              id: "duration",
              ok: false,
              file: piece.name,
              message: `${piece.name} is ${seconds} s, shorter than a second`,
              details: { seconds },
            });
            ok = false;
          } else if (maxSeconds !== undefined && info.duration_seconds > maxSeconds + TOLERANCE_SECONDS) {
            checks.push({
              id: "duration",
              ok: false,
              file: piece.name,
              message: `${piece.name} is ${seconds} s; the limit is ${maxSeconds} s`,
              details: { seconds, max_seconds: maxSeconds },
            });
            ok = false;
          } else {
            checks.push({
              id: "duration",
              ok: true,
              file: piece.name,
              message: `${piece.name} is ${seconds} s${maxSeconds !== undefined ? ` (limit ${maxSeconds} s)` : ""}`,
              details: { seconds },
            });
          }
        }
      }
      if (info.kind === "image") {
        if (info.width === undefined || info.height === undefined) {
          checks.push({
            id: "dimensions",
            ok: true,
            file: piece.name,
            message: `${piece.name}: size not readable from a ${info.mime ?? "unknown"} file; a person should check it`,
            details: { readable: false },
          });
          uncertain = true;
        } else if (Math.min(info.width, info.height) < MIN_IMAGE_SIDE) {
          checks.push({
            id: "dimensions",
            ok: false,
            file: piece.name,
            message: `${piece.name} is ${info.width}×${info.height}, smaller than ${MIN_IMAGE_SIDE} px on a side`,
            details: { width: info.width, height: info.height },
          });
          ok = false;
        } else {
          checks.push({
            id: "dimensions",
            ok: true,
            file: piece.name,
            message: `${piece.name} is ${info.width}×${info.height}`,
            details: { width: info.width, height: info.height },
          });
        }
      }
      if (ok) accepted += 1;
    }
    const outcome = checks.some((c) => !c.ok) ? "fail" : uncertain ? "uncertain" : "pass";
    return { verifier: "media", outcome, checks, accepted_units: accepted };
  },
});
