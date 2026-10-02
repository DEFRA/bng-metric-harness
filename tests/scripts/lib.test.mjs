import { afterEach, describe, expect, it, vi } from "vitest";
import { mapInSequence, pollUntil } from "../../scripts/_lib.mjs";

describe("mapInSequence", () => {
  it("resolves to each step's result, in order", async () => {
    const results = await mapInSequence([1, 2, 3], async (n, i) => n * 10 + i);
    expect(results).toEqual([10, 21, 32]);
  });

  it("starts each step only once the one before has finished", async () => {
    const events = [];
    await mapInSequence(["a", "b", "c"], async (item) => {
      events.push(`start ${item}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      events.push(`end ${item}`);
    });
    expect(events).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });

  it("resolves to nothing for no items", async () => {
    expect(await mapInSequence([], () => 1)).toEqual([]);
  });

  it("stops at, and rejects with, the first step that throws", async () => {
    const seen = [];
    await expect(
      mapInSequence([1, 2, 3], async (n) => {
        seen.push(n);
        if (n === 2) {
          throw new Error("step 2");
        }
      }),
    ).rejects.toThrow("step 2");
    expect(seen).toEqual([1, 2]);
  });
});

describe("pollUntil", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds at once when the first try does", async () => {
    const probe = vi.fn(async () => true);
    expect(await pollUntil(probe, { attempts: 3, intervalMs: 1000 })).toBe(
      true,
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries after the interval, counting a throw as a failed try", async () => {
    vi.useFakeTimers();
    const answers = [
      () => Promise.reject(new Error("refused")),
      () => Promise.resolve(false),
      () => Promise.resolve(true),
    ];
    const probe = vi.fn(() => answers.shift()());

    const polling = pollUntil(probe, { attempts: 5, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(await polling).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last attempt, without waiting again", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => false);

    const polling = pollUntil(probe, { attempts: 3, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(await polling).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
