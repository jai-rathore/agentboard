import { authorize, listModels } from "../_muse.mjs";
export async function GET(request) { return authorize(request) ?? listModels(); }
