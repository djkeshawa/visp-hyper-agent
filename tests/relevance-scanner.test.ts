import { describe, expect, it } from "vitest";
import { keywordsForGoal } from "../src/context/relevance-scanner.js";

describe("keywordsForGoal", () => {
  it("keeps meaningful goal words", () => {
    expect(keywordsForGoal("implement offline note sync")).toEqual(["implement", "offline", "note", "sync"]);
  });

  it("removes short words and stop words", () => {
    expect(keywordsForGoal("add AI to the CLI")).toEqual(["add", "cli"]);
  });
});

