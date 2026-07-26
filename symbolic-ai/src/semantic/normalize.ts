import type {
  NormalizationEvidence,
  NormalizedSemanticInput,
  RawTextRange,
} from "./types";

type NormalizedView = "surface" | "matchKey";

interface TextUnit {
  readonly text: string;
  readonly rawRange: RawTextRange;
}

const PUNCTUATION_MAP: Readonly<Record<string, string>> = Object.freeze({
  "，": ",",
  "。": ".",
  "？": "?",
  "！": "!",
  "；": ";",
  "：": ":",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "～": "~",
});

const LEADING_FILLERS = new Set(["嗯", "呃", "唔"]);
const TRAILING_FILLERS = new Set(["呀", "啊", "呢", "哦", "啦"]);
const EDGE_DELIMITER_PATTERN = /[\s,.;:!?'"()[\]~]/u;

function freezeRange(start: number, end: number): RawTextRange {
  return Object.freeze({ start, end });
}

function freezeEvidence(
  evidence: NormalizationEvidence,
): NormalizationEvidence {
  return Object.freeze({
    ...evidence,
    rawRange: Object.freeze({ ...evidence.rawRange }),
  });
}

function unitsFromRaw(raw: string): readonly TextUnit[] {
  const units: TextUnit[] = [];
  let rawOffset = 0;

  for (const character of raw) {
    const start = rawOffset;
    rawOffset += character.length;
    units.push(
      Object.freeze({
        text: character,
        rawRange: freezeRange(start, rawOffset),
      }),
    );
  }

  return units;
}

function emitSurface(
  raw: string,
  transformations: NormalizationEvidence[],
): readonly TextUnit[] {
  const sourceUnits = unitsFromRaw(raw);
  const result: TextUnit[] = [];
  let index = 0;

  while (index < sourceUnits.length) {
    const unit = sourceUnits[index]!;

    if (/\s/u.test(unit.text)) {
      const whitespaceStart = index;
      let whitespaceEnd = index + 1;

      while (
        whitespaceEnd < sourceUnits.length &&
        /\s/u.test(sourceUnits[whitespaceEnd]!.text)
      ) {
        whitespaceEnd += 1;
      }

      const whitespaceUnits = sourceUnits.slice(whitespaceStart, whitespaceEnd);
      const rawRange = freezeRange(
        whitespaceUnits[0]!.rawRange.start,
        whitespaceUnits[whitespaceUnits.length - 1]!.rawRange.end,
      );
      const sourceText = raw.slice(rawRange.start, rawRange.end);
      const isEdge =
        whitespaceStart === 0 || whitespaceEnd === sourceUnits.length;

      if (isEdge) {
        transformations.push(
          freezeEvidence({
            stage: "surface",
            kind: "whitespace-trimmed",
            rawRange,
            sourceText,
            targetText: "",
          }),
        );
      } else {
        result.push(Object.freeze({ text: " ", rawRange }));

        if (sourceText !== " ") {
          transformations.push(
            freezeEvidence({
              stage: "surface",
              kind: "whitespace-collapsed",
              rawRange,
              sourceText,
              targetText: " ",
            }),
          );
        }
      }

      index = whitespaceEnd;
      continue;
    }

    const normalizedPunctuation = PUNCTUATION_MAP[unit.text];
    if (normalizedPunctuation !== undefined) {
      result.push(
        Object.freeze({
          text: normalizedPunctuation,
          rawRange: unit.rawRange,
        }),
      );
      transformations.push(
        freezeEvidence({
          stage: "surface",
          kind: "punctuation-normalized",
          rawRange: unit.rawRange,
          sourceText: unit.text,
          targetText: normalizedPunctuation,
        }),
      );
    } else {
      result.push(unit);
    }

    index += 1;
  }

  return result;
}

function isDelimiter(unit: TextUnit | undefined): boolean {
  return unit !== undefined && EDGE_DELIMITER_PATTERN.test(unit.text);
}

function removeDelimitedEdgeFillers(
  units: readonly TextUnit[],
  transformations: NormalizationEvidence[],
): readonly TextUnit[] {
  let start = 0;
  let end = units.length;

  while (
    start < end &&
    LEADING_FILLERS.has(units[start]!.text) &&
    isDelimiter(units[start + 1])
  ) {
    const filler = units[start]!;
    let removalEnd = start + 1;

    while (removalEnd < end && isDelimiter(units[removalEnd])) {
      removalEnd += 1;
    }

    const removed = units.slice(start, removalEnd);
    const rawRange = freezeRange(
      filler.rawRange.start,
      removed[removed.length - 1]!.rawRange.end,
    );
    transformations.push(
      freezeEvidence({
        stage: "match-key",
        kind: "edge-filler-removed",
        rawRange,
        sourceText: removed.map((unit) => unit.text).join(""),
        targetText: "",
      }),
    );
    start = removalEnd;
  }

  while (
    end > start &&
    TRAILING_FILLERS.has(units[end - 1]!.text) &&
    isDelimiter(units[end - 2])
  ) {
    const filler = units[end - 1]!;
    let removalStart = end - 1;

    while (removalStart > start && isDelimiter(units[removalStart - 1])) {
      removalStart -= 1;
    }

    const removed = units.slice(removalStart, end);
    const rawRange = freezeRange(
      removed[0]!.rawRange.start,
      filler.rawRange.end,
    );
    transformations.push(
      freezeEvidence({
        stage: "match-key",
        kind: "edge-filler-removed",
        rawRange,
        sourceText: removed.map((unit) => unit.text).join(""),
        targetText: "",
      }),
    );
    end = removalStart;
  }

  return units.slice(start, end);
}

function emitMatchKey(
  surfaceUnits: readonly TextUnit[],
  transformations: NormalizationEvidence[],
): readonly TextUnit[] {
  const edgeNormalized = removeDelimitedEdgeFillers(
    surfaceUnits,
    transformations,
  );
  const result: TextUnit[] = [];

  for (const unit of edgeNormalized) {
    const lower = unit.text.toLocaleLowerCase("und");
    result.push(Object.freeze({ text: lower, rawRange: unit.rawRange }));

    if (lower !== unit.text) {
      transformations.push(
        freezeEvidence({
          stage: "match-key",
          kind: "case-folded",
          rawRange: unit.rawRange,
          sourceText: unit.text,
          targetText: lower,
        }),
      );
    }
  }

  return result;
}

function materialize(units: readonly TextUnit[]): {
  readonly text: string;
  readonly mapping: readonly RawTextRange[];
} {
  const mapping: RawTextRange[] = [];
  let text = "";

  for (const unit of units) {
    text += unit.text;
    for (let index = 0; index < unit.text.length; index += 1) {
      mapping.push(unit.rawRange);
    }
  }

  return Object.freeze({
    text,
    mapping: Object.freeze(mapping),
  });
}

export function normalizeSemanticInput(
  raw: string,
): NormalizedSemanticInput {
  const transformations: NormalizationEvidence[] = [];
  const surfaceUnits = emitSurface(raw, transformations);
  const matchKeyUnits = emitMatchKey(surfaceUnits, transformations);
  const surface = materialize(surfaceUnits);
  const matchKey = materialize(matchKeyUnits);

  return Object.freeze({
    raw,
    surface: surface.text,
    matchKey: matchKey.text,
    surfaceToRaw: surface.mapping,
    matchKeyToRaw: matchKey.mapping,
    transformations: Object.freeze(transformations),
  });
}

/**
 * Converts a normalized UTF-16 range back to the smallest raw range that
 * contains all of its source spans.
 */
export function mapNormalizedRangeToRaw(
  input: NormalizedSemanticInput,
  view: NormalizedView,
  start: number,
  end: number,
): RawTextRange {
  const text = view === "surface" ? input.surface : input.matchKey;
  const mapping =
    view === "surface" ? input.surfaceToRaw : input.matchKeyToRaw;

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > text.length
  ) {
    throw new RangeError(
      `Normalized range must be within ${view} UTF-16 bounds.`,
    );
  }

  if (start === end) {
    if (start < mapping.length) {
      return freezeRange(mapping[start]!.start, mapping[start]!.start);
    }

    if (mapping.length > 0) {
      const last = mapping[mapping.length - 1]!;
      return freezeRange(last.end, last.end);
    }

    return freezeRange(0, 0);
  }

  let rawStart = mapping[start]!.start;
  let rawEnd = mapping[start]!.end;

  for (let index = start + 1; index < end; index += 1) {
    rawStart = Math.min(rawStart, mapping[index]!.start);
    rawEnd = Math.max(rawEnd, mapping[index]!.end);
  }

  return freezeRange(rawStart, rawEnd);
}
