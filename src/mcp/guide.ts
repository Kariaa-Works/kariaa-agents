export const SERVER_INSTRUCTIONS = `Work Protocol: find work, apply, do it, submit it, track it, across connectors (sources).
Ids look like <connector>:<id>; keep them exactly as returned.
- search_jobs with no query lists tasks you can do right now; with a query it also searches job listings. category narrows it to one way of earning: micro_task (clipping, UGC, data work), bounty, selling, competition or job; list_connectors says each source's category and whether it pays in fiat or crypto.
- A job with kind "task" is done here: apply_to_job, then add_work until progress.ready_to_submit, then submit_work, then get_application for the outcome.
- A job's stages say what you can do with it here. Most listings have none and are applied to on the employer's page (url, apply_hint); a listing whose stages include apply (OpenTask, NEAR Agent Market, Superteam Earn, and others) is applied to here like a task.
- Before applying to a task, read its requirements: questions to answer, what files or text to send, how_to, rules.
- verify_work checks pieces against the requirements before add_work (kinds, count, clip length, image size, duplicates, text quality) and says what they would pay; fix anything it fails rather than sending it.
- whoami shows which connectors are signed in and what a profile still needs; update_profile fixes it.
- connect_account gets you onto a platform: on auth_required, call it with the connector. Where the platform lets agents sign up (NEAR Agent Market, Superteam Earn) it registers with the owner's email, after the person agrees; elsewhere it gives the page where the person makes the key, and save_credentials keeps the key once they hand it to you.
- my_earnings shows what accepted work has paid and how a payout works; request_payout asks for the money, only after the person has confirmed amount, method and destination.
- Errors come back as results with an error code: auth_required (set the connector's key), not_ready (do something first), wrong_stage, invalid_input, not_supported (the source does not offer that stage), rate_limited (retry_after seconds).`;

export const GUIDE_MARKDOWN = `# Work Protocol guide

## Finding work
- \`search_jobs\` with no \`query\` lists tasks available now (kind \`task\`): work you can do and submit through this server.
- With a \`query\` (a role, a skill) it also asks the job boards for listings (kind \`listing\`). Most are applied to on the employer's page; some boards take applications here.
- \`location\`, \`remote\`, \`kind\`, \`category\`, \`media\` (text, image, audio, video) and \`connectors\` narrow it. \`category\` is how a source pays: \`micro_task\` (clipping, UGC, data work), \`bounty\` (paid per accepted deliverable), \`selling\` (goods and digital products the person owns), \`competition\` (prize pools) or \`job\` (employer and freelance work). \`list_connectors\` names the sources, their category and payout rails (fiat, crypto, employer), and which are signed in.
- Anything public or costly (publishing a listing, posting a claim, filing a bug report) waits for the person: the source says what confirmation to pass, for example \`submit_work\` with \`note\` \`confirm:<token>\` or \`answers.acknowledge_policy\` \`yes\`. Ask them before passing it.
- Results carry \`stages\`: what you can do with that job here. A task has apply, upload, submit, status; most listings have none, and a listing on a board that takes applications has apply.

## Doing a task
1. \`get_job\` for the full task: \`requirements.questions\`, \`requirements.files\` (kinds, count, max seconds), \`requirements.text\` (for written answers), \`how_to\`, \`looks_like\`, \`rules\`, and \`instructions\` (the material itself).
2. \`apply_to_job\` with \`answers\` by question id (choice answers take the option text or its number), an optional \`preferred_rate\` and \`note\`. The result is an application with a \`stage\`:
   - \`applied\`: waiting for the source to unlock the work; check back with \`get_application\`.
   - \`work_needed\`: send the work now.
3. \`verify_work\` with the pieces first: it runs the same deterministic checks a platform can run (enough pieces, right kinds, clip length, image size, duplicates, written answers that read as answers) and says what the accepted pieces would pay. \`fail\` means fix it; \`uncertain\` means a person will look.
4. \`add_work\` once per sample: \`text\` for written work, or \`file\` with \`url\` (https), \`base64\` (small files) or \`path\` (only when this server runs on the person's own machine). Watch \`progress.received\` / \`wanted\`; \`ready_to_submit\` says when enough is in. \`remove_work\` takes one back.
5. \`submit_work\` when ready. The stage becomes \`in_review\`, later \`accepted\` or \`rejected\` with \`review.note\`.
6. \`get_work_link\` gives a web link where the person can finish in a browser, for media they have on their phone.

## Accounts
- \`whoami\` shows each signed-in connector, whether the profile is ready to apply and what is \`missing\`.
- \`update_profile\` with \`connector\` and \`fields\`; \`list_connectors\` lists the accepted field names.
- \`connect_account\` with no \`connector\` lists every platform that needs an account: \`connected\`, or \`action_needed\` with \`steps\`, the \`url\` where the key is made and the \`fields\` to save.
- \`connect_account\` with \`connector\` and \`email\` registers an agent account on platforms whose API allows it (NEAR Agent Market, Superteam Earn). Ask the person first: the account is in their name, and they get an email to claim it.
- \`save_credentials\` with \`connector\` and \`values\` keeps a key or token the person gives you. The platform is asked first, and a key it refuses is not kept. Keys are kept on this machine, or in the person's vault on the hosted server.
- Kariaa keys come from https://www.kariaa.com/datahouse/connect (set KARIAA_API_KEY), or by signing in with Kariaa in Claude, ChatGPT or Perplexity.

## Getting paid
- \`my_earnings\` lists, per connector, the balance, pending credits, each accepted piece of work with its amount, payouts so far, the minimum payout and the methods.
- \`request_payout\` with \`connector\`, \`method\`, \`destination\` and optionally \`amount\` asks for the money. Confirm the amount, method and destination with the person first; a payout cannot be taken back. One open request at a time: a second one answers \`already_exists\`.
- A connector that cannot pay answers \`not_supported\`.

## Errors
Every tool returns errors as results: \`error\` is one of not_supported, not_found, auth_required, rate_limited, invalid_input, not_ready, wrong_stage, already_exists, timeout, upstream_error, with a \`message\` and details. \`already_exists\` on add_work means the same file is already in; carry on. \`rate_limited\` carries \`retry_after\` seconds.

## Giving work out

On a platform whose stages include \`post\`, you can also be the one who pays: post a job, read the offers, pick one, review what comes back, pay.

- \`post_job\` with the connector, a title, a full description, a budget and how the work will be judged. Posting pays nothing.
- \`list_offers\` shows who offered, for how much, and what they delivered. \`award_offer\` picks one.
- \`review_work\`: accept, request_changes (say exactly what) or reject (say why).
- \`pay_for_work\` always takes two calls. The first moves nothing and answers confirm_needed with the amount, the fee, the receiver and a token. Show that to the person. Call again with \`confirm\` only after they agree.
- \`my_postings\` lists what you posted and where each stands. \`cancel_posting\` closes one and says what happens to money set aside.
- The person you act for decides the budget, the award and every payment. Ask each time.
`;
