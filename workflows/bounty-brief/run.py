"""Bounty brief: finds open bounties, reads the best ones in full and writes a brief
of what each one asks for, so a person (or the next agent) can start on the work.

    work trace -- python workflows/bounty-brief/run.py
    work trace -- python workflows/bounty-brief/run.py --topic security

(`python3` on macOS and most Linux.)

Python 3.9+, no packages to install. It talks to the Work API's MCP server over
stdio, the same server Claude, Cursor and other hosts use.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER = ["node", os.path.join(ROOT, "dist", "cli", "index.js"), "mcp"]


class WorkApi:
    """A minimal MCP client: JSON-RPC 2.0, one JSON object per line on stdin/stdout."""

    def __init__(self):
        if not os.path.exists(SERVER[1]):
            sys.exit("Build first: npm install && npm run build")
        try:
            self.proc = subprocess.Popen(SERVER, stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=ROOT,
                                         text=True, encoding="utf-8", bufsize=1)
        except FileNotFoundError:
            sys.exit("Node.js 20 or newer is needed on the PATH: https://nodejs.org")
        self.next_id = 0
        self._request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "bounty-brief", "version": "1.0"},
        })
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def _request(self, method, params):
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        while True:
            line = self.proc.stdout.readline()
            if not line:
                sys.exit("The Work API server stopped.")
            message = json.loads(line)
            if message.get("id") == self.next_id:
                if "error" in message:
                    raise RuntimeError(message["error"].get("message", "MCP error"))
                return message["result"]

    def call(self, tool, **arguments):
        """Calls one tool. Returns (data, error): data is the tool's structured result."""
        result = self._request("tools/call", {"name": tool, "arguments": arguments})
        data = result.get("structuredContent") or {}
        if result.get("isError"):
            # An error result is {"error": "<code>", "message": "..."}.
            text = (result.get("content") or [{}])[0].get("text", "")
            return None, {"code": data.get("error") or "error", "message": data.get("message") or text}
        return data, None

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=15)


def money(job):
    return (job.get("pay") or {}).get("text") or "pay not stated"


def main():
    # Print any language's text the same way on every terminal.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    topic = ""
    if "--topic" in sys.argv:
        at = sys.argv.index("--topic") + 1
        if at >= len(sys.argv):
            sys.exit('Give a topic: --topic security')
        topic = sys.argv[at]
    api = WorkApi()
    lines = ["# Bounty brief" + (f": {topic}" if topic else ""), ""]
    try:
        # 1. Find: open bounties, newest sources first.
        found, error = api.call("search_jobs", category="bounty", limit=12, **({"query": topic} if topic else {}))
        if error:
            sys.exit(f"search failed: {error['code']}: {error['message']}")
        print(f"found {found['count']} bounties")
        for miss in found.get("partial", []):
            print(f"  {miss['connector']} did not answer: {miss['error']['code']}: {miss['error'].get('message', '')[:120]}", file=sys.stderr)

        # 2. Pick: one per source, so the brief is not ten bounties from one board.
        picks, seen = [], set()
        for job in found["jobs"]:
            source = job["id"].split(":", 1)[0]
            if source not in seen:
                seen.add(source)
                picks.append(job)
        picks = picks[:4]

        # 3. Read each in full and write down what it asks for.
        for pick in picks:
            job, error = api.call("get_job", job_id=pick["id"])
            if error:
                print(f"  could not read {pick['id']}: {error['code']}", file=sys.stderr)
                job = pick
            needs = job.get("requirements") or {}
            can_act = [stage for stage in ("apply", "upload", "submit") if stage in job.get("stages", [])]
            lines += [
                f"## {job['title']}" + (f" · {job['org']}" if job.get("org") else ""),
                "",
                f"- id: `{job['id']}`",
                f"- pays: {money(job)}",
                f"- through the API: {', '.join(can_act) if can_act else 'read only; finish on the site'}",
            ]
            if job.get("url"):
                lines.append(f"- link: {job['url']}")
            if job.get("apply_hint"):
                lines.append(f"- to take part: {job['apply_hint']}")
            for rule in (needs.get("rules") or [])[:5]:
                lines.append(f"- rule: {rule}")
            for question in (needs.get("questions") or [])[:5]:
                lines.append(f"- asks: {question['question']}")
            summary = (job.get("summary") or job.get("description") or "").strip().replace("\n", " ")
            if summary:
                lines += ["", summary[:500] + ("…" if len(summary) > 500 else "")]
            lines.append("")

        out = os.path.join(os.getcwd(), ".work", "bounty-brief.md")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines))
        print(f"{len(picks)} bounties from {len(seen)} sources. Brief: {os.path.relpath(out)}")
    finally:
        api.close()


if __name__ == "__main__":
    main()
