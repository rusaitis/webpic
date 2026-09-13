import { describe, expect, it, vi } from "vitest";
import { createDisposableBag } from "./disposableBag.ts";

describe("createDisposableBag", () => {
  it("returns the resource it tracks, so tracking rides the construction line", () => {
    const bag = createDisposableBag();
    const resource = { dispose: vi.fn() };
    expect(bag.add(resource)).toBe(resource);
  });

  it("disposes everything it holds, in creation order", () => {
    const order: string[] = [];
    const bag = createDisposableBag();
    bag.add({ dispose: () => order.push("geometry") });
    bag.add({ dispose: () => order.push("material") });
    bag.add({ dispose: () => order.push("texture") });

    bag.dispose();

    expect(order).toEqual(["geometry", "material", "texture"]);
  });

  it("frees nothing twice when disposed twice", () => {
    const bag = createDisposableBag();
    const resource = { dispose: vi.fn() };
    bag.add(resource);

    bag.dispose();
    bag.dispose();

    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
});
