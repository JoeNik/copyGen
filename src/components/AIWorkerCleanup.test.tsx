// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub the matchMedia / SW APIs jsdom doesn't provide
beforeEach(() => {
  vi.clearAllMocks();
});

describe("AIWorkerCleanup", () => {
  it("renders nothing", async () => {
    const { default: AIWorkerCleanup } = await import("@/components/AIWorkerCleanup");
    const { render } = await import("@testing-library/react");
    const { container } = render(<AIWorkerCleanup />);
    expect(container.firstChild).toBeNull();
  });

  it("unregisters only /ai-worker.js registrations", async () => {
    const unregister = vi.fn().mockResolvedValue(undefined);
    const aiReg = {
      active: { scriptURL: "https://example.com/ai-worker.js?v=3" },
      waiting: null,
      installing: null,
      unregister,
    };
    const otherReg = {
      active: { scriptURL: "https://example.com/other-worker.js" },
      waiting: null,
      installing: null,
      unregister: vi.fn(),
    };
    const getRegistrations = vi.fn().mockResolvedValue([aiReg, otherReg]);
    (navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
      getRegistrations,
    };

    const { default: AIWorkerCleanup } = await import("@/components/AIWorkerCleanup");
    const { render } = await import("@testing-library/react");
    render(<AIWorkerCleanup />);

    // Wait for the effect's promise
    await new Promise((r) => setTimeout(r, 50));

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(otherReg.unregister).not.toHaveBeenCalled();
  });

  it("no-ops when Service Workers are unsupported", async () => {
    const original = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    const { default: AIWorkerCleanup } = await import("@/components/AIWorkerCleanup");
    const { render } = await import("@testing-library/react");
    // Should not throw
    render(<AIWorkerCleanup />);
    (navigator as unknown as { serviceWorker?: unknown }).serviceWorker = original;
  });
});