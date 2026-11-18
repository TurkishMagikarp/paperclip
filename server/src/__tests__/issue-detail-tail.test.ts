import { describe, expect, it, vi } from "vitest";
import { readIssueDetailTail } from "../routes/issue-detail-tail.js";

describe("full issue detail after recovery revalidation", () => {
  it("starts the independent projections without serializing them", async () => {
    let finish!: (value: string) => void;
    const blocker = new Promise<string>((resolve) => { finish = resolve; });
    const readInterruption = vi.fn(async () => null);
    const response = readIssueDetailTail(false, () => blocker, readInterruption);
    expect(readInterruption).toHaveBeenCalledOnce();
    finish("blocker");
    expect(await response).toEqual({ executionBlocker: "blocker", interruption: null });
  });

  it("does no final reads for an already-disconnected board", async () => {
    const read = vi.fn(async () => null);
    expect(await readIssueDetailTail(true, read, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not turn a failed read into a successful partial response", async () => {
    const failure = new Error("projection failed");
    await expect(readIssueDetailTail(false, async () => null, async () => { throw failure; }))
      .rejects.toBe(failure);
  });
});
