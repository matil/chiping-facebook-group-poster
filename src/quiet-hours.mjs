const TIME_ZONE = 'Asia/Jerusalem';
const QUIET_START_MINUTE = 30;
const QUIET_END_MINUTE = 6 * 60;

export function isFacebookQuietHours(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const minuteOfDay = hour * 60 + minute;
  return minuteOfDay >= QUIET_START_MINUTE && minuteOfDay < QUIET_END_MINUTE;
}
