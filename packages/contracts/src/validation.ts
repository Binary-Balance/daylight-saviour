export type JsonObject = Record<string, unknown>;

/** Field checks that fail through each validator's own error type. */
export function fieldChecks(fail: (path: string, problem: string) => never) {
  return {
    objectAt(value: unknown, path: string): JsonObject {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(path, 'expected an object');
      }

      return value as JsonObject;
    },

    exactKeys(object: JsonObject, path: string, expected: string[]) {
      const actual = Object.keys(object).sort();
      const wanted = [...expected].sort();

      if (
        actual.length !== wanted.length ||
        actual.some((key, index) => key !== wanted[index])
      ) {
        fail(path, `expected keys ${wanted.join(', ')}`);
      }
    },

    stringAt(value: unknown, path: string): string {
      if (typeof value !== 'string' || value.length === 0) {
        return fail(path, 'expected a non-empty string');
      }

      return value;
    },

    integerAt(value: unknown, path: string): number {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return fail(path, 'expected a safe integer');
      }

      return value;
    },
  };
}
