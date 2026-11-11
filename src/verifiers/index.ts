import type { Verifier } from "../core/verifier.js";
import { duplicates } from "./duplicates/index.js";
import { media } from "./media/index.js";
import { requirements } from "./requirements/index.js";
import { secrets } from "./secrets/index.js";
import { text } from "./text/index.js";

/** Every verifier that ships with the package. All deterministic. */
export const builtInVerifiers: Verifier[] = [requirements, media, duplicates, text, secrets];

export { duplicates, media, requirements, secrets, text };
