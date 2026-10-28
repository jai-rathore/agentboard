import { describe, it, expect } from "vitest";
import { modelName, isOpenWeight } from "../src/models";

describe("model labels", () => {
  it("labels Muse Spark and the open-weight Muse Spark Open distinctly", () => {
    expect(modelName("muse-spark-1.3")).toBe("Muse Spark 1.3");
    expect(modelName("meta-models/muse-spark-open")).toBe("Muse Spark Open (open-weight, Baseten)");
    expect(modelName("meta-models/muse-spark-open-1026")).toContain("open-weight, Baseten");
    expect(isOpenWeight("meta-models/muse-spark-open")).toBe(true);
    expect(isOpenWeight("muse-spark-1.3")).toBe(false);
    expect(modelName(undefined)).toBe("Muse");
  });
});
