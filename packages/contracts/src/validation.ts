export type JsonObject = Record<string, unknown>;

// Each validator reports through its own error type.
type Fail = (path: string, problem: string) => never;

export function objectAt(value: unknown, path: string, fail: Fail): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected an object');
  }

  return value as JsonObject;
}

export function exactKeys(
  object: JsonObject,
  path: string,
  expected: string[],
  fail: Fail,
) {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();

  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(path, `expected keys ${wanted.join(', ')}`);
  }
}

export function stringAt(value: unknown, path: string, fail: Fail): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(path, 'expected a non-empty string');
  }

  return value;
}

export function integerAt(value: unknown, path: string, fail: Fail): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return fail(path, 'expected a safe integer');
  }

  return value;
}
