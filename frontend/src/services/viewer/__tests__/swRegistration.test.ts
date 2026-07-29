import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock navigator.serviceWorker at module scope so it exists before import.
const mockRegister = vi.fn();
const mockGetRegistration = vi.fn();
const mockUnregister = vi.fn();
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();

// We patch globalThis.navigator before importing the module under test.
vi.stubGlobal('navigator', {
  serviceWorker: {
    register: mockRegister,
    getRegistration: mockGetRegistration,
    controller: null,
    addEventListener: mockAddEventListener,
    removeEventListener: mockRemoveEventListener,
  },
});

// Dynamic import so the global stub is in place before module resolution.
const { registerWasmServiceWorker, unregisterWasmServiceWorker, listenForSwActivation } =
  await import('../swRegistration');

beforeEach(() => {
  vi.clearAllMocks();
  // Reset controller to null between tests
  Object.defineProperty(navigator.serviceWorker, 'controller', {
    value: null, writable: true, configurable: true,
  });
});

describe('registerWasmServiceWorker', () => {
  it('returns unsupported when serviceWorker is absent', async () => {
    vi.stubGlobal('navigator', {});
    const { registerWasmServiceWorker: reg } = await import('../swRegistration');
    const result = await reg();
    expect(result.status).toBe('unsupported');
    // restore
    vi.stubGlobal('navigator', {
      serviceWorker: { register: mockRegister, getRegistration: mockGetRegistration },
    });
  });

  it('returns already-active when the active SW carries the current build stamp', async () => {
    mockGetRegistration.mockResolvedValue(undefined);
    mockRegister.mockResolvedValue({ installing: {} });
    await registerWasmServiceWorker();
    const registeredUrl = mockRegister.mock.calls[0][0] as string;
    mockRegister.mockClear();

    mockGetRegistration.mockResolvedValue({
      active: { state: 'activated', scriptURL: `https://example.test${registeredUrl}` },
    });
    const result = await registerWasmServiceWorker();
    expect(result.status).toBe('already-active');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('re-registers when the active SW was installed by a different build', async () => {
    mockGetRegistration.mockResolvedValue({
      active: { state: 'activated', scriptURL: 'https://example.test/sw.js?v=stale-build' },
    });
    mockRegister.mockResolvedValue({ installing: {} });
    const result = await registerWasmServiceWorker();
    expect(mockRegister).toHaveBeenCalledOnce();
    expect(result.status).toBe('registered');
  });

  it('registers /sw.js with a build stamp so the cache namespace cannot go stale', async () => {
    mockGetRegistration.mockResolvedValue(undefined);
    mockRegister.mockResolvedValue({ installing: {} });
    const result = await registerWasmServiceWorker();
    expect(mockRegister).toHaveBeenCalledOnce();
    const [url, options] = mockRegister.mock.calls[0];
    expect(url).toMatch(/^\/sw\.js\?v=.+/);
    expect(options).toEqual({ scope: '/' });
    expect(result.status).toBe('registered');
  });

  it('calls register when existing registration has no active worker', async () => {
    mockGetRegistration.mockResolvedValue({ active: null });
    mockRegister.mockResolvedValue({ installing: {} });
    const result = await registerWasmServiceWorker();
    expect(mockRegister).toHaveBeenCalledOnce();
    expect(result.status).toBe('registered');
  });

  it('returns error status when register throws', async () => {
    mockGetRegistration.mockResolvedValue(undefined);
    mockRegister.mockRejectedValue(new Error('blocked by COOP'));
    const result = await registerWasmServiceWorker();
    expect(result.status).toBe('error');
    expect(result.error).toContain('blocked by COOP');
  });

  it('returns error status when getRegistration throws', async () => {
    mockGetRegistration.mockRejectedValue(new Error('SW not allowed'));
    const result = await registerWasmServiceWorker();
    expect(result.status).toBe('error');
    expect(result.error).toContain('SW not allowed');
  });
});

describe('unregisterWasmServiceWorker', () => {
  it('returns false when serviceWorker is absent', async () => {
    vi.stubGlobal('navigator', {});
    const { unregisterWasmServiceWorker: unreg } = await import('../swRegistration');
    expect(await unreg()).toBe(false);
    vi.stubGlobal('navigator', {
      serviceWorker: { register: mockRegister, getRegistration: mockGetRegistration },
    });
  });

  it('returns false when no registration is found', async () => {
    mockGetRegistration.mockResolvedValue(undefined);
    expect(await unregisterWasmServiceWorker()).toBe(false);
  });

  it('calls unregister on the found registration and returns its result', async () => {
    mockUnregister.mockResolvedValue(true);
    mockGetRegistration.mockResolvedValue({ unregister: mockUnregister });
    expect(await unregisterWasmServiceWorker()).toBe(true);
    expect(mockUnregister).toHaveBeenCalledOnce();
  });
});

describe('listenForSwActivation', () => {
  it('returns no-op cleanup when serviceWorker is absent', async () => {
    vi.stubGlobal('navigator', {});
    const { listenForSwActivation: listen } = await import('../swRegistration');
    const cb = vi.fn();
    const cleanup = listen(cb);
    expect(cb).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: mockRegister,
        getRegistration: mockGetRegistration,
        controller: null,
        addEventListener: mockAddEventListener,
        removeEventListener: mockRemoveEventListener,
      },
    });
  });

  it('fires callback immediately when controller is already set', () => {
    Object.defineProperty(navigator.serviceWorker, 'controller', {
      value: { state: 'activated' }, writable: true, configurable: true,
    });
    const cb = vi.fn();
    listenForSwActivation(cb);
    expect(cb).toHaveBeenCalledOnce();
    expect(mockAddEventListener).not.toHaveBeenCalled();
  });

  it('adds controllerchange listener when controller is not yet set', () => {
    const cb = vi.fn();
    listenForSwActivation(cb);
    expect(cb).not.toHaveBeenCalled();
    expect(mockAddEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function));
  });

  it('fires callback on controllerchange when controller becomes non-null', () => {
    const cb = vi.fn();
    listenForSwActivation(cb);
    const [, handler] = mockAddEventListener.mock.calls[0];
    // Simulate SW taking control
    Object.defineProperty(navigator.serviceWorker, 'controller', {
      value: { state: 'activated' }, writable: true, configurable: true,
    });
    handler();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('does not fire callback if controller is still null at controllerchange', () => {
    const cb = vi.fn();
    listenForSwActivation(cb);
    const [, handler] = mockAddEventListener.mock.calls[0];
    handler(); // controller is still null
    expect(cb).not.toHaveBeenCalled();
  });

  it('cleanup removes the controllerchange listener', () => {
    const cb = vi.fn();
    const cleanup = listenForSwActivation(cb);
    const [, handler] = mockAddEventListener.mock.calls[0];
    cleanup();
    expect(mockRemoveEventListener).toHaveBeenCalledWith('controllerchange', handler);
  });
});
