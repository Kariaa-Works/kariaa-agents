# Remote OK

Find and read remote job listings from Remote OK's [public JSON feed](https://remoteok.com/api). No account or key is needed, and this connector does not apply to jobs.

- Search runs locally over the feed because the API returns its current listing set.
- Every result links directly to its original Remote OK posting and carries the `source:remoteok` tag, as the [feed terms](https://remoteok.com/faq) require.
- Salary figures are shown as listed. The feed does not always identify a currency or pay period, so the connector does not infer either.
- No account, API key or paid API call is used.
