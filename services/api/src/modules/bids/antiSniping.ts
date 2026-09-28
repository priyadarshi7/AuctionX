// Section 18: "auction ends in < 30 seconds + valid bid arrives -> extend
// auction." Kept as a pure function of (currentEndTime, now) so the rule
// itself is trivially unit-testable without a transaction or a lock — the
// atomicity requirement (Section 18: "this must be handled atomically")
// lives in repository.ts's transaction, not here.
//
// The same duration serves as both the trigger window and the extension
// length: a valid bid landing within 30s of the end pushes the end to
// exactly 30s from THAT bid's arrival, not from the old scheduled end —
// guaranteeing a fair, fixed response window after the most recent valid
// bid, however many times that repeats in a bidding war.
export const ANTI_SNIPING_WINDOW_MS = 30_000;

// Returns the new endTime if an extension applies, or null if the bid
// landed outside the trigger window and nothing should change.
export function computeExtendedEndTime(currentEndTime: Date, now: Date): Date | null {
  const remainingMs = currentEndTime.getTime() - now.getTime();
  if (remainingMs >= ANTI_SNIPING_WINDOW_MS) {
    return null;
  }
  return new Date(now.getTime() + ANTI_SNIPING_WINDOW_MS);
}
