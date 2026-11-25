// Keep normal tests independent of the developer's opted-in queue/provider settings.
// Integration suites explicitly select their own fake providers and queue mode afterwards.
process.env.BACKGROUND_JOBS_MODE = 'legacy';
process.env.EMAIL_ENABLED = 'false';
process.env.SEPAY_ENABLED = 'false';
