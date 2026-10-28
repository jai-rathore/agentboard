import { authorize, responses } from "../_muse.mjs";
// Video understanding can take a while; loop turns are 2-12 s.
export const config = { maxDuration: 90 };
export async function POST(request) { return authorize(request) ?? responses(request); }
