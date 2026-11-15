export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Часы панели: используется и в UI, и в ответах API. */
export function serverClock(now = new Date()) {
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    /* ignore */
  }
  return {
    now: now.toISOString(),
    timezone,
    // Смещение в минутах восточнее UTC (Екатеринбург = +300).
    offsetMinutes: -now.getTimezoneOffset(),
    utcOffset: formatOffset(-now.getTimezoneOffset()),
  };
}

function formatOffset(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${mins}`;
}
