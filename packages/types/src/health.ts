/** Response shape for the GET /health endpoint */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  /**
   * Commit the running image was built from, stamped into the image as
   * APP_VERSION (Dockerfile ARG GIT_SHA). 'unknown' for local/unstamped builds.
   */
  version: string;
}
