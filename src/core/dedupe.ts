import type { Job } from "./types.js";

/** The key two listings share when they point at the same posting. */
export function dedupeKey(job: Job): string {
  if (!job.url) return job.id;
  try {
    const url = new URL(job.url);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|fbclid|gclid)/iu.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return `${url.hostname}${url.pathname}${url.search}`;
  } catch {
    return job.url.toLowerCase();
  }
}
