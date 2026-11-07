// Keep the registered account implementation unchanged. After a wall-clock
// correction, wait for real time to catch up rather than inventing an effective
// observation time that could execute orders or settle labels prematurely.
export function adaptiveAccountClockStatus(study, now) {
  const createdAt = study?.state?.createdAt, lastNow = study?.lastNow;
  if (!Number.isFinite(now) || now < 0 || !Number.isFinite(createdAt) || createdAt < 0 ||
      !Number.isFinite(lastNow) || lastNow < createdAt) throw Error('Invalid adaptive account clock');
  const resumeAt = Math.max(createdAt, lastNow);
  return now < resumeAt
    ? { ready: false, status: 'waiting-for-clock', now, resumeAt, waitMs: resumeAt - now }
    : { ready: true, status: 'ready', now, resumeAt: null, waitMs: 0 };
}
