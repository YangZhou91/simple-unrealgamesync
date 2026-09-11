/** Detect userinfo even in malformed URLs, before they reach storage or IPC. */
export function proxyUrlHasCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
  } catch {
    // A malformed credential-bearing value must not bypass the guard.
  }
  return value.includes("@");
}

export const PROXY_CREDENTIALS_ERROR = "proxy_credentials_not_supported";
