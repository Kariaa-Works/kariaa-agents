import { inspectMedia } from "../../core/media.js";
import { defineVerifier, type Check } from "../../core/verifier.js";

/** A choice answer matches an option by its text, its number, or a unique prefix of three or more characters. */
export function matchOption(options: string[], given: string): string | undefined {
  const t = given.trim().replace(/[.!]$/u, "").toLowerCase();
  if (!t) return undefined;
  if (/^\d{1,2}$/u.test(t)) return options[Number(t) - 1];
  const exact = options.find((o) => o.toLowerCase() === t);
  if (exact) return exact;
  if (t.length < 3) return undefined;
  const prefixed = options.filter((o) => o.toLowerCase().startsWith(t));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** The work matches what the task asks for: pieces, kinds, sizes, text limits, required answers. */
export const requirements = defineVerifier({
  id: "requirements",
  name: "Requirements",
  description:
    "Enough pieces of the allowed kinds and size, written answers within their limits, required questions answered with valid options.",
  deterministic: true,
  verify({ job, work, answers }) {
    const checks: Check[] = [];
    const req = job.requirements ?? {};
    const files = work.filter((w) => w.kind === "file");
    const texts = work.filter((w) => w.kind === "text");
    const perPiece = new Map<number, boolean>();
    work.forEach((_w, i) => perPiece.set(i, true));
    const failPiece = (index: number) => perPiece.set(index, false);

    if (req.files) {
      const kinds = req.files.kinds;
      const textCounts = kinds.includes("text") || kinds.includes("txt");
      const pieces = files.length + (textCounts ? texts.length : 0);
      const wanted = req.files.count ?? 1;
      checks.push({
        id: "count",
        ok: pieces >= wanted,
        message: pieces >= wanted ? `${pieces} of ${wanted} pieces in` : `${pieces} of ${wanted} pieces in; ${wanted - pieces} more needed`,
        details: { received: pieces, wanted },
      });
      work.forEach((piece, index) => {
        if (piece.kind === "text") {
          if (!textCounts) {
            checks.push({
              id: "kind",
              ok: false,
              file: `text ${index + 1}`,
              message: `Written text given, but this task takes ${kinds.join(", ")} files`,
            });
            failPiece(index);
          }
          return;
        }
        const info = inspectMedia(piece.bytes, piece.name, piece.mime_type);
        const ext = piece.name.includes(".") ? piece.name.split(".").pop()?.toLowerCase() : undefined;
        const mimeExt =
          info.mime === "application/pdf"
            ? "pdf"
            : info.mime === "application/msword"
              ? "doc"
              : info.mime?.includes("wordprocessingml")
                ? "docx"
                : info.mime === "text/plain"
                  ? "txt"
                  : info.mime === "application/rtf" || info.mime === "text/rtf"
                    ? "rtf"
                    : undefined;
        const matchedKind = kinds.includes(info.kind)
          ? info.kind
          : mimeExt && kinds.includes(mimeExt)
            ? mimeExt
            : ext && kinds.includes(ext) && info.kind !== "image" && info.kind !== "audio" && info.kind !== "video"
              ? ext
              : undefined;
        const ok = Boolean(matchedKind);
        checks.push({
          id: "kind",
          ok,
          file: piece.name,
          message: ok
            ? `${piece.name} is ${matchedKind}`
            : `${piece.name} is ${info.kind === "other" ? "not a media file" : info.kind}; this task takes ${kinds.join(", ")}`,
          details: { mime: info.mime, kind: matchedKind ?? info.kind },
        });
        if (!ok) failPiece(index);
        if (req.files!.max_bytes !== undefined) {
          const within = piece.bytes.byteLength <= req.files!.max_bytes;
          checks.push({
            id: "size",
            ok: within,
            file: piece.name,
            message: within
              ? `${piece.name} is within the size limit`
              : `${piece.name} is ${Math.round(piece.bytes.byteLength / 1_048_576)} MB; the limit is ${Math.round(req.files!.max_bytes / 1_048_576)} MB`,
          });
          if (!within) failPiece(index);
        }
      });
    }

    if (req.text) {
      work.forEach((piece, index) => {
        if (piece.kind !== "text") return;
        const length = piece.text.trim().length;
        const min = req.text!.min_chars ?? 1;
        const max = req.text!.max_chars ?? Number.POSITIVE_INFINITY;
        const ok = length >= min && length <= max;
        checks.push({
          id: "text_length",
          ok,
          file: `text ${index + 1}`,
          message: ok
            ? `Written answer is ${length} characters`
            : length < min
              ? `Written answer is ${length} characters; at least ${min} needed`
              : `Written answer is ${length} characters; at most ${max} allowed`,
        });
        if (!ok) failPiece(index);
      });
      if (texts.length === 0 && !req.files) checks.push({ id: "count", ok: false, message: "A written answer is needed" });
    }

    if (!req.files && !req.text && !req.output_schema && work.length === 0 && !(req.questions?.length && answers !== undefined)) {
      checks.push({ id: "count", ok: false, message: "No work given" });
    }

    if (req.output_schema && Object.keys(req.output_schema).length > 0) {
      checks.push(...checkOutputSchema(req.output_schema, work, answers, failPiece));
    }

    for (const q of req.questions ?? []) {
      const given = answers?.[q.id];
      const present = given !== undefined && (Array.isArray(given) ? given.length > 0 : String(given).trim().length > 0);
      if (q.required)
        checks.push({ id: `answer:${q.id}`, ok: present, message: present ? `Answered: ${q.question}` : `Not answered: ${q.question}` });
      if (present && q.options?.length && (q.type === "select" || q.type === "multiselect")) {
        const items = Array.isArray(given) ? given : [String(given)];
        const invalid = items.filter((item) => !matchOption(q.options!, item));
        checks.push({
          id: `option:${q.id}`,
          ok: invalid.length === 0,
          message:
            invalid.length === 0
              ? `Valid choice for: ${q.question}`
              : `${invalid.map((i) => JSON.stringify(i)).join(", ")} is not one of ${q.options.join(" / ")}`,
          details: { options: q.options },
        });
      }
    }

    const outcome = checks.some((c) => !c.ok) ? "fail" : "pass";
    return { verifier: "requirements", outcome, checks, accepted_units: [...perPiece.values()].filter(Boolean).length };
  },
});

function checkOutputSchema(
  schema: Record<string, unknown>,
  work: Parameters<typeof requirements.verify>[0]["work"],
  answers: Record<string, string | string[]> | undefined,
  failPiece: (index: number) => void,
): Check[] {
  const checks: Check[] = [];
  let payload: unknown;
  const textIndex = work.findIndex((w) => w.kind === "text");
  const fileIndex = work.findIndex((w) => w.kind === "file");

  if (textIndex >= 0 && work[textIndex]!.kind === "text") {
    try {
      payload = JSON.parse((work[textIndex] as { kind: "text"; text: string }).text);
    } catch {
      failPiece(textIndex);
      return [
        {
          id: "output_schema",
          ok: false,
          file: `text ${textIndex + 1}`,
          message: "Deliverable text is not valid JSON as required by output_schema",
        },
      ];
    }
  } else if (fileIndex >= 0 && work[fileIndex]!.kind === "file") {
    const f = work[fileIndex] as { kind: "file"; name: string; bytes: Uint8Array };
    try {
      payload = JSON.parse(Buffer.from(f.bytes).toString("utf8"));
    } catch {
      failPiece(fileIndex);
      return [
        {
          id: "output_schema",
          ok: false,
          file: f.name,
          message: `${f.name} is not valid JSON as required by output_schema`,
        },
      ];
    }
  } else if (answers && Object.keys(answers).length > 0) {
    payload = answers;
  } else {
    return [
      {
        id: "output_schema",
        ok: false,
        message: "No JSON deliverable provided to validate against output_schema",
      },
    ];
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (textIndex >= 0) failPiece(textIndex);
    if (fileIndex >= 0) failPiece(fileIndex);
    return [
      {
        id: "output_schema",
        ok: false,
        message: "Deliverable must be a JSON object matching output_schema",
      },
    ];
  }

  const record = payload as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};

  for (const reqKey of required) {
    const val = record[reqKey];
    if (val === undefined || val === null || val === "") {
      if (textIndex >= 0) failPiece(textIndex);
      if (fileIndex >= 0) failPiece(fileIndex);
      checks.push({
        id: `output_schema:${reqKey}`,
        ok: false,
        message: `Missing required output_schema field "${reqKey}"`,
        details: { field: reqKey, reason: "required" },
      });
    }
  }

  for (const [propKey, propSpec] of Object.entries(properties)) {
    const val = record[propKey];
    if (val === undefined || val === null) continue;
    if (!propSpec || typeof propSpec !== "object") continue;

    const expectedType = typeof propSpec.type === "string" ? propSpec.type : undefined;
    if (expectedType) {
      const actualType = Array.isArray(val) ? "array" : typeof val;
      const typeOk =
        expectedType === "array"
          ? Array.isArray(val)
          : expectedType === "integer"
            ? typeof val === "number" && Number.isInteger(val)
            : expectedType === "object"
              ? typeof val === "object" && !Array.isArray(val)
              : actualType === expectedType;
      if (!typeOk) {
        if (textIndex >= 0) failPiece(textIndex);
        if (fileIndex >= 0) failPiece(fileIndex);
        checks.push({
          id: `output_schema:${propKey}`,
          ok: false,
          message: `Field "${propKey}" has type ${actualType}, expected ${expectedType}`,
          details: { field: propKey, expected: expectedType, got: actualType },
        });
        continue;
      }
    }

    if (typeof val === "string" && typeof propSpec.minLength === "number" && val.length < propSpec.minLength) {
      if (textIndex >= 0) failPiece(textIndex);
      if (fileIndex >= 0) failPiece(fileIndex);
      checks.push({
        id: `output_schema:${propKey}`,
        ok: false,
        message: `Field "${propKey}" is ${val.length} chars; at least ${propSpec.minLength} needed`,
        details: { field: propKey, minLength: propSpec.minLength, length: val.length },
      });
      continue;
    }

    if (typeof val === "number" && typeof propSpec.minimum === "number" && val < propSpec.minimum) {
      if (textIndex >= 0) failPiece(textIndex);
      if (fileIndex >= 0) failPiece(fileIndex);
      checks.push({
        id: `output_schema:${propKey}`,
        ok: false,
        message: `Field "${propKey}" is ${val}; minimum is ${propSpec.minimum}`,
        details: { field: propKey, minimum: propSpec.minimum, value: val },
      });
      continue;
    }

    if (Array.isArray(propSpec.enum) && propSpec.enum.length > 0 && !propSpec.enum.includes(val)) {
      if (textIndex >= 0) failPiece(textIndex);
      if (fileIndex >= 0) failPiece(fileIndex);
      checks.push({
        id: `output_schema:${propKey}`,
        ok: false,
        message: `Field "${propKey}" value ${JSON.stringify(val)} is not one of ${propSpec.enum.join(" / ")}`,
        details: { field: propKey, enum: propSpec.enum, value: val },
      });
      continue;
    }

    checks.push({
      id: `output_schema:${propKey}`,
      ok: true,
      message: `Field "${propKey}" matches output_schema`,
    });
  }

  if (checks.length === 0) {
    checks.push({
      id: "output_schema",
      ok: true,
      message: "Deliverable matches output_schema",
    });
  }

  return checks;
}
