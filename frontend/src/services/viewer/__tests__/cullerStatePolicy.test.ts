import { describe, expect, it } from 'vitest';
import { decideCullerPolicy } from '../cullerStatePolicy';

describe('decideCullerPolicy', () => {
  it('disables element culling for BasicHouse-sized synthetic models', () => {
    expect(decideCullerPolicy({
      navigationState: 'idle',
      elementCount: 149,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: false,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    })).toEqual({
      mode: 'disabled',
      runShowPass: false,
      runHidePass: false,
      elementCullerEnabled: false,
      storeyCullerEnabled: false,
    });
  });

  it('stands down when user isolation or hidden elements own visibility', () => {
    expect(decideCullerPolicy({
      navigationState: 'idle',
      elementCount: 500,
      isolatedCount: 2,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 20,
    })).toMatchObject({
      mode: 'stand-down-user-visibility',
      runShowPass: false,
      runHidePass: false,
    });
  });

  it('runs show-only work during navigation', () => {
    expect(decideCullerPolicy({
      navigationState: 'navigating',
      elementCount: 500,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 20,
    })).toMatchObject({
      mode: 'show-only',
      runShowPass: true,
      runHidePass: false,
    });
  });

  it('runs hide work only after idle', () => {
    expect(decideCullerPolicy({
      navigationState: 'idle',
      elementCount: 500,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    })).toMatchObject({
      mode: 'hide-after-idle',
      runShowPass: false,
      runHidePass: true,
    });
  });
});
