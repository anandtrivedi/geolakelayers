import { getToken, gatewayHeaders } from './auth'

// One per gateway, shared by every instance of the widget in this window (the runtime, and in the builder
// also the settings window, where other widgets' settings read Databricks layers too)
const interceptorFor = new Set<string>()

/**
 * Add the gateway token (and the chosen warehouse) to every ArcGIS Maps SDK request to the gateway.
 * esriConfig is passed in: the runtime imports it, the builder window has to load the SDK first.
 */
export function ensureInterceptor (esriConfig: __esri.config, gateway: string): void {
  if (interceptorFor.has(gateway)) return
  interceptorFor.add(gateway)
  // Only the first matching interceptor runs, and Experience Builder registers a catch-all one at startup,
  // so ours has to go first or gateway requests go out without the token (and fall back to the Portal proxy)
  esriConfig.request.interceptors.unshift({
    urls: gateway,
    before: (params: any) => {
      if (!getToken(gateway)) return
      params.requestOptions.headers = { ...(params.requestOptions.headers || {}), ...gatewayHeaders(gateway) }
    }
  })
}
