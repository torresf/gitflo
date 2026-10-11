import { describe, expect, it } from "vitest";
import { GitLock } from "../gitLock";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("GitLock", () => {
  it("refuses a second write while one is running", async () => {
    const lock = new GitLock();
    const first = deferred();
    const running = lock.run("Pull", () => first.promise);
    expect(lock.busy).toBe("Pull");
    expect(await lock.run("Merge", async () => 1)).toBeNull();
    first.resolve();
    await running;
    expect(lock.busy).toBeNull();
    expect(await lock.run("Merge", async () => 1)).toEqual({ value: 1 });
  });

  it("releases the lock when the write throws", async () => {
    const lock = new GitLock();
    await expect(
      lock.run("Pull", async () => {
        throw new Error("conflict");
      }),
    ).rejects.toThrow("conflict");
    expect(lock.busy).toBeNull();
  });

  it("skips the background task while a write holds the lock", async () => {
    const lock = new GitLock();
    const write = deferred();
    const running = lock.run("Pull", () => write.promise);
    let ran = false;
    expect(await lock.runBackground(async () => void (ran = true))).toBe(false);
    expect(ran).toBe(false);
    write.resolve();
    await running;
  });

  it("makes a write wait for the background task in flight", async () => {
    const lock = new GitLock();
    const fetch = deferred();
    const order: string[] = [];
    const background = lock.runBackground(async () => {
      await fetch.promise;
      order.push("fetch");
    });
    const write = lock.run("Pull", async () => void order.push("pull"));
    expect(lock.busy).toBe("Pull");
    fetch.resolve();
    await Promise.all([background, write]);
    expect(order).toEqual(["fetch", "pull"]);
  });

  it("does not stack background tasks", async () => {
    const lock = new GitLock();
    const first = deferred();
    const running = lock.runBackground(() => first.promise);
    expect(await lock.runBackground(async () => undefined)).toBe(false);
    first.resolve();
    expect(await running).toBe(true);
  });
});
