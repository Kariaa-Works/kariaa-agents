/** What a key or token looks like, for the checks that keep them out of the repo. */
export const SECRETS = [
  [/\bkra_[A-Za-z0-9_-]{16,}/u, "a Kariaa key"],
  [/\bsk[-_](?:live_|test_|ant-|proj-)?[A-Za-z0-9_-]{20,}/u, "an API key (sk-…)"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/u, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/u, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/u, "an AWS key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/u, "a Google API key"],
  [/\bxox[abpsr]-[A-Za-z0-9-]{20,}/u, "a Slack token"],
  [/\b(?:mj_live|aat|UGSK_live|whsec|rk_live)_[A-Za-z0-9]{16,}/u, "a platform key"],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/u, "a signed token (JWT)"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "a private key"],
];
