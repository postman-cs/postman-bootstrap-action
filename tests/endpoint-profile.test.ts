import { describe, expect, it } from 'vitest';

import {
  EMULATOR_PROFILE_ENV,
  EMULATOR_PROFILE_NAME,
  ENDPOINT_OVERRIDE_ENV,
  POSTMAN_ENDPOINT_PROFILES,
  resolvePostmanEndpointProfile
} from '../src/lib/postman/base-urls.js';
import { resolveInputs } from '../src/index.js';

function armed(overrides: Record<string, string>): Record<string, string | undefined> {
  return { [EMULATOR_PROFILE_ENV]: EMULATOR_PROFILE_NAME, ...overrides };
}

const COMPLETE_OVERRIDES = {
  [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: 'http://127.0.0.1:8081/api',
  [ENDPOINT_OVERRIDE_ENV.bifrostBaseUrl]: 'http://127.0.0.1:8082/bifrost',
  [ENDPOINT_OVERRIDE_ENV.gatewayBaseUrl]: 'http://127.0.0.1:8085/gateway',
  [ENDPOINT_OVERRIDE_ENV.iapubBaseUrl]: 'http://127.0.0.1:8083/iapub',
  [ENDPOINT_OVERRIDE_ENV.appVersionBaseUrl]: 'http://127.0.0.1:8084/app-version'
};

describe('bootstrap endpoint profile defaults', () => {
  it('preserves the live prod hosts when the emulator profile is absent', () => {
    expect(resolvePostmanEndpointProfile('prod', 'us', {})).toMatchObject({
      apiBaseUrl: 'https://api.getpostman.com',
      bifrostBaseUrl: 'https://bifrost-premium-https-v4.gw.postman.com',
      gatewayBaseUrl: 'https://gateway.postman.com',
      iapubBaseUrl: 'https://iapub.postman.co',
      appVersionBaseUrl: 'https://dl.pstmn.io'
    });
  });

  it('preserves the live beta and EU defaults', () => {
    expect(resolvePostmanEndpointProfile('beta', 'us', {})).toMatchObject({
      apiBaseUrl: 'https://api.getpostman-beta.com',
      bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com',
      gatewayBaseUrl: 'https://gateway.postman-beta.com',
      iapubBaseUrl: 'https://iapub.postman.co',
      appVersionBaseUrl: 'https://dl.pstmn.io'
    });
    expect(resolvePostmanEndpointProfile('prod', 'eu', {}).apiBaseUrl).toBe(
      'https://api.eu.postman.com'
    );
    expect(POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl).toBe('https://api.getpostman.com');
  });
});

describe('bootstrap emulator endpoint profile', () => {
  it('atomically redirects API, Bifrost, gateway, iapub, app-version, and cold fallback hosts', () => {
    expect(resolvePostmanEndpointProfile('prod', 'us', armed(COMPLETE_OVERRIDES))).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:8081/api',
      bifrostBaseUrl: 'http://127.0.0.1:8082/bifrost',
      fallbackBaseUrl: 'http://127.0.0.1:8082/bifrost',
      gatewayBaseUrl: 'http://127.0.0.1:8085/gateway',
      iapubBaseUrl: 'http://127.0.0.1:8083/iapub',
      appVersionBaseUrl: 'http://127.0.0.1:8084/app-version'
    });
  });

  it('threads the armed profile through the shared Action and CLI input resolver', () => {
    const inputs = resolveInputs(armed(COMPLETE_OVERRIDES));
    expect(inputs).toMatchObject({
      postmanApiBase: 'http://127.0.0.1:8081/api',
      postmanBifrostBase: 'http://127.0.0.1:8082/bifrost',
      postmanFallbackBase: 'http://127.0.0.1:8082/bifrost',
      postmanGatewayBase: 'http://127.0.0.1:8085/gateway',
      postmanIapubBase: 'http://127.0.0.1:8083/iapub',
      postmanAppVersionBase: 'http://127.0.0.1:8084/app-version'
    });
  });

  it('normalizes trailing slashes and ignores the selected live stack', () => {
    const env = armed(
      Object.fromEntries(
        Object.entries(COMPLETE_OVERRIDES).map(([name, value]) => [name, `${value}///`])
      )
    );
    expect(resolvePostmanEndpointProfile('beta', 'us', env)).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:8081/api',
      bifrostBaseUrl: 'http://127.0.0.1:8082/bifrost',
      gatewayBaseUrl: 'http://127.0.0.1:8085/gateway',
      iapubBaseUrl: 'http://127.0.0.1:8083/iapub',
      appVersionBaseUrl: 'http://127.0.0.1:8084/app-version'
    });
  });

  it.each(['http://localhost:8080/api', 'https://[::1]:8443/api'])(
    'accepts loopback emulator host %s',
    (apiBaseUrl) => {
      expect(
        resolvePostmanEndpointProfile(
          'prod',
          'us',
          armed({ ...COMPLETE_OVERRIDES, [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: apiBaseUrl })
        ).apiBaseUrl
      ).toBe(apiBaseUrl);
    }
  );
});

describe('bootstrap emulator endpoint profile fail-closed validation', () => {
  it('rejects overrides without the arming variable', () => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', {
        [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.apiBaseUrl]
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it.each(['', '   '])('rejects an unarmed %j override before returning live hosts', (value) => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', {
        [ENDPOINT_OVERRIDE_ENV.gatewayBaseUrl]: value
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it('rejects an empty arming value when an override is present', () => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', {
        [EMULATOR_PROFILE_ENV]: '  ',
        [ENDPOINT_OVERRIDE_ENV.bifrostBaseUrl]:
          COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.bifrostBaseUrl]
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it.each(['live', 'prod', 'container', 'Emulator'])('rejects unknown profile %j', (profile) => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', { [EMULATOR_PROFILE_ENV]: profile })
    ).toThrow('ENDPOINT_PROFILE_UNKNOWN');
  });

  it.each(Object.entries(ENDPOINT_OVERRIDE_ENV))(
    'rejects an armed profile missing %s',
    (_field, omitted) => {
      const env = armed({ ...COMPLETE_OVERRIDES });
      delete env[omitted];
      expect(() => resolvePostmanEndpointProfile('prod', 'us', env)).toThrow(
        'ENDPOINT_PROFILE_OVERRIDE_MISSING'
      );
      expect(() => resolvePostmanEndpointProfile('prod', 'us', env)).toThrow(omitted);
    }
  );

  it.each([
    ['relative URL', 'relative/path'],
    ['non-http scheme', 'ftp://127.0.0.1:8081'],
    ['credentials', 'http://user:pass@127.0.0.1:8081'], // trufflehog:ignore -- placeholder the profile must reject
    ['query string', 'http://127.0.0.1:8081?team=1'],
    ['fragment', 'http://127.0.0.1:8081#fragment'],
    ['whitespace', '   ']
  ])('rejects a malformed %s override', (_label, value) => {
    expect(() =>
      resolvePostmanEndpointProfile(
        'prod',
        'us',
        armed({ ...COMPLETE_OVERRIDES, [ENDPOINT_OVERRIDE_ENV.iapubBaseUrl]: value })
      )
    ).toThrow(/ENDPOINT_PROFILE_OVERRIDE_(INVALID|MISSING)/);
  });

  it.each(Object.entries(ENDPOINT_OVERRIDE_ENV))(
    'names malformed %s override failures',
    (_field, envName) => {
      expect(() =>
        resolvePostmanEndpointProfile(
          'prod',
          'us',
          armed({ ...COMPLETE_OVERRIDES, [envName]: 'ftp://127.0.0.1:8081' })
        )
      ).toThrow(envName);
    }
  );

  it.each([
    'http://169.254.169.254/latest',
    'http://10.0.0.8/api',
    'https://metadata.google.internal/computeMetadata/v1',
    'https://attacker.example/api'
  ])('rejects a non-loopback emulator endpoint %s', (value) => {
    expect(() =>
      resolvePostmanEndpointProfile(
        'prod',
        'us',
        armed({ ...COMPLETE_OVERRIDES, [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: value })
      )
    ).toThrow(/ENDPOINT_PROFILE_OVERRIDE_INVALID.*loopback/);
  });
});
