import { describe, expect, test } from "vitest";
import { formatValue, roundDragged } from "./DragNumberInput";

describe("number field precision", () => {
  test("small values keep three significant digits instead of reading 0", () => {
    expect(formatValue(1.5e-5, false)).toBe("0.000015");
    expect(formatValue(0.123456, false)).toBe("0.123");
    expect(formatValue(12.34567, false)).toBe("12.346");
    expect(formatValue(0, false)).toBe("0");
    expect(formatValue(7.6, true)).toBe("8");
  });

  test("dragging with a fine step keeps the step's digits", () => {
    expect(roundDragged(1.5e-5 + 2e-6, 1e-6)).toBeCloseTo(1.7e-5, 12);
    expect(roundDragged(1.5e-5, 1e-6)).not.toBe(0);
    expect(roundDragged(0.12345, 0.1)).toBe(0.123);
  });
});
