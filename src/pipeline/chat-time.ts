// Adapted from SignLoop apps/web/lib/chat-time.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776

export function buildAuthoritativeUtcTimeContext(
  now: Date = new Date(),
): string {
  const currentUtcTimestamp = now.toISOString();
  const currentUtcDate = currentUtcTimestamp.slice(0, 10);

  return `
Authoritative application time context:
- Current UTC timestamp: ${currentUtcTimestamp}
- Current UTC calendar date: ${currentUtcDate}
This time is supplied by the running application and overrides stale date assumptions from model training. Never infer today's date from a training cutoff.
For calendar-date comparisons: dates before ${currentUtcDate} are in the past, ${currentUtcDate} is today, and dates after ${currentUtcDate} are in the future.
`.trim();
}
