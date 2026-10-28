import { authorize, chat } from "../../_muse.mjs";
export const config = { maxDuration: 30 };
export async function POST(request) { return authorize(request) ?? chat(request); }
