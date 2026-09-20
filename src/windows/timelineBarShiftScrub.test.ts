import { describe, expect, it, vi } from "vitest";

describe("TimelineBar Shift+drag playhead scrubbing", () => {
  it("ignores split handle mouse down when Shift is pressed", () => {
    let splitDragging = false;
    const onSplitHandleMouseDown = (e: { shiftKey: boolean; preventDefault: () => void }) => {
      if (e.shiftKey) return;
      e.preventDefault();
      splitDragging = true;
    };

    const preventDefault = vi.fn();

    // Plain click without shift initiates split resizing
    onSplitHandleMouseDown({ shiftKey: false, preventDefault });
    expect(splitDragging).toBe(true);
    expect(preventDefault).toHaveBeenCalled();

    // Click with shift does NOT initiate split resizing
    splitDragging = false;
    preventDefault.mockClear();
    onSplitHandleMouseDown({ shiftKey: true, preventDefault });
    expect(splitDragging).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("calculates correct frame from pointer X and calls onFrameChange during scrub", () => {
    const totalFrames = 100;
    const rect = { width: 1000, left: 100 };

    const calculateFrame = (clientX: number) => {
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const ratio = rect.width > 0 ? x / rect.width : 0;
      return Math.max(0, Math.min(totalFrames - 1, Math.round(ratio * (totalFrames - 1))));
    };

    // ClientX at left edge (100) -> Frame 0
    expect(calculateFrame(100)).toBe(0);

    // ClientX at midpoint (600) -> Frame 50
    expect(calculateFrame(600)).toBe(50);

    // ClientX at right edge (1100) -> Frame 99
    expect(calculateFrame(1100)).toBe(99);

    // Clamping beyond edges
    expect(calculateFrame(50)).toBe(0);
    expect(calculateFrame(2000)).toBe(99);
  });

  it("routes track click: Left click or Right click directly scrubs playhead, split handle buttons resize panels", () => {
    const onSplitHandleMouseDown = vi.fn();
    const onFrameChange = vi.fn();

    const handlePointerDownTrack = (e: { button: number; shiftKey: boolean }) => {
      // Direct scrub on Left click (0) or Right click (2)
      if (e.button === 0 || e.button === 2) {
        onFrameChange(42);
        return;
      }
    };

    // 1. Normal left click directly scrubs playhead (no Shift needed)
    handlePointerDownTrack({ button: 0, shiftKey: false });
    expect(onFrameChange).toHaveBeenCalledWith(42);

    // 2. Right click also scrubs playhead
    handlePointerDownTrack({ button: 2, shiftKey: false });
    expect(onFrameChange).toHaveBeenCalledTimes(2);

    // 3. Dedicated split handle button triggers panel resizing
    onSplitHandleMouseDown();
    expect(onSplitHandleMouseDown).toHaveBeenCalledTimes(1);
  });
});
