const MAX_TRUSTED_INSTRUCTIONS = 32;
const MAX_TRUSTED_INSTRUCTION_BYTES = 4_096;
const SECRET_LIKE =
  /(?:\bbearer\s+\S+|\bbasic\s+\S+|\b(?:ghp_|github_pat_|sk[-_]|AKIA|ASIA)[A-Za-z0-9_-]+|-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|(?:secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:^|\D)\d{3}[- ]\d{2}[- ]\d{4}(?:$|\D)|(?:^|\D)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?:$|\D))/i;

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validTrustedInstructions(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_TRUSTED_INSTRUCTIONS
  ) {
    return false;
  }
  const encoder = new TextEncoder();
  return value.every(
    (instruction) =>
      typeof instruction === "string" &&
      instruction.length > 0 &&
      instruction === instruction.trim() &&
      !hasUnsafeControl(instruction) &&
      !hasUnpairedSurrogate(instruction) &&
      !SECRET_LIKE.test(instruction) &&
      encoder.encode(instruction).length <= MAX_TRUSTED_INSTRUCTION_BYTES,
  );
}
