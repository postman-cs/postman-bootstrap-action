export type PostmanStack = 'prod' | 'beta';
export type PostmanRegion = 'us' | 'eu';

export interface PostmanEndpointProfile {
  apiBaseUrl: string;
  bifrostBaseUrl: string;
  /** App `/_api` alias of the Bifrost proxy: cold serial fallback when the
   * primary Bifrost edge fails transiently. Same envelope, same auth. */
  fallbackBaseUrl: string;
  cliInstallUrl: string;
  cliWindowsInstallUrl: string;
  gatewayBaseUrl: string;
  iapubBaseUrl: string;
}

export const POSTMAN_ENDPOINT_PROFILES: Record<PostmanStack, PostmanEndpointProfile> = {
  prod: {
    apiBaseUrl: 'https://api.getpostman.com',
    bifrostBaseUrl: 'https://bifrost-premium-https-v4.gw.postman.com',
    fallbackBaseUrl: 'https://go.postman.co/_api',
    cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    cliWindowsInstallUrl: 'https://dl-cli.pstmn.io/install/win64.ps1',
    gatewayBaseUrl: 'https://gateway.postman.com',
    iapubBaseUrl: 'https://iapub.postman.co'
  },
  beta: {
    apiBaseUrl: 'https://api.getpostman-beta.com',
    bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com',
    fallbackBaseUrl: 'https://go.postman-beta.co/_api',
    cliInstallUrl: 'https://dl-cli.pstmn-beta.io/install/unix.sh',
    cliWindowsInstallUrl: 'https://dl-cli.pstmn-beta.io/install/win64.ps1',
    gatewayBaseUrl: 'https://gateway.postman-beta.com',
    iapubBaseUrl: 'https://iapub.postman.co'
  }
};

export function resolvePostmanCliInstallUrl(
  profile: PostmanEndpointProfile,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? profile.cliWindowsInstallUrl : profile.cliInstallUrl;
}

export function parsePostmanRegion(value: string | undefined): PostmanRegion {
  const normalized = String(value || 'us').trim().toLowerCase();
  if (normalized === 'us' || normalized === 'eu') {
    return normalized;
  }
  throw new Error(`Unsupported postman-region "${value}". Supported values: us, eu`);
}

export function parsePostmanStack(value: string | undefined): PostmanStack {
  const normalized = String(value || 'prod').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'beta') {
    return normalized;
  }
  throw new Error(`Unsupported postman-stack "${value}". Supported values: prod, beta`);
}

export function resolvePostmanEndpointProfile(
  stack: PostmanStack,
  region: PostmanRegion = 'us'
): PostmanEndpointProfile {
  if (stack === 'beta' && region !== 'us') {
    throw new Error('postman-region=eu is only supported with postman-stack=prod');
  }
  const profile = POSTMAN_ENDPOINT_PROFILES[stack];
  if (region === 'eu') {
    return {
      ...profile,
      apiBaseUrl: 'https://api.eu.postman.com'
    };
  }
  return profile;
}
