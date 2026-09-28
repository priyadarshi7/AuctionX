import { ANTI_SNIPING_WINDOW_MS, computeExtendedEndTime } from '../../src/modules/bids/antiSniping';

describe('computeExtendedEndTime', () => {
  it('does not extend when comfortably more than the window remains', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const endTime = new Date(now.getTime() + 5 * 60_000);
    expect(computeExtendedEndTime(endTime, now)).toBeNull();
  });

  it('does not extend exactly at the boundary (remaining === window)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const endTime = new Date(now.getTime() + ANTI_SNIPING_WINDOW_MS);
    expect(computeExtendedEndTime(endTime, now)).toBeNull();
  });

  it('extends when just inside the boundary (remaining === window - 1ms)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const endTime = new Date(now.getTime() + ANTI_SNIPING_WINDOW_MS - 1);
    const result = computeExtendedEndTime(endTime, now);
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(now.getTime() + ANTI_SNIPING_WINDOW_MS);
  });

  it('extends to exactly window-ms from now, not from the old endTime', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    // Only 5 seconds left — a bid this late should still land the new end
    // exactly WINDOW_MS from now, not old-endTime + WINDOW_MS.
    const endTime = new Date(now.getTime() + 5_000);
    const result = computeExtendedEndTime(endTime, now);
    expect(result!.getTime()).toBe(now.getTime() + ANTI_SNIPING_WINDOW_MS);
  });

  it('extends an already-passed endTime the same way (still window-ms from now)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const endTime = new Date(now.getTime() - 1_000);
    const result = computeExtendedEndTime(endTime, now);
    expect(result!.getTime()).toBe(now.getTime() + ANTI_SNIPING_WINDOW_MS);
  });
});
