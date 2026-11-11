# Security

If you find a vulnerability, report it privately through the repository's **Security → Report a vulnerability** page (GitHub private vulnerability reporting). Do not open a public issue.

Include what you found, how to reproduce it, and what it could affect. You will get an acknowledgement within a few days and a fix or a plan within a reasonable time; please hold public disclosure until then.

## What matters here

- **Credentials.** Connector keys live in the environment and are never logged or returned by any tool. A report that shows a key leaking anywhere is high priority.
- **The hosted server.** `work serve` acts as the key owner for anyone who can reach the port; it is meant to run behind `WORK_HTTP_TOKEN`. Bypasses of the token, of the body size cap, or of the DNS-rebinding check are in scope.
- **Fetching work by URL.** `file.url` must only ever reach public https hosts; anything that lets a request reach a private address, follow a redirect, or read a local file over HTTP is in scope.
- **Connectors and verifiers from third parties.** They run in-process with the host's credentials. Review what you load through `WORK_CONNECTOR_MODULES` and `WORK_VERIFIER_MODULES` as you would any dependency.

Supported: the latest release on the `main` branch.
