// Display names for the models that produced a draft, verdict, judgement or replay turn.
export const MODEL_NAMES: Record<string, string> = { "muse-spark-1.3": "Muse Spark 1.3", "meta-models/muse-spark-open": "Muse Spark Open (open-weight, Baseten)" };
/** True for Meta's open-weight Muse Spark Open (the optional Baseten path), whatever slug the node is configured with. */
export const isOpenWeight = (model?: string | null) => Boolean(model && /muse-spark-open/i.test(model));
export const modelName = (model?: string | null) => (model ? MODEL_NAMES[model] ?? (isOpenWeight(model) ? `Muse Spark Open (open-weight, Baseten): ${model}` : model) : "Muse");
