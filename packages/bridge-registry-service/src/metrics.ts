/**
 * Minimal Prometheus-text metrics registry (audit item R3).
 *
 * A dependency-free counter registry rendered in the Prometheus text
 * exposition format (version 0.0.4) at `GET /metrics`. The service tracks:
 *
 * - `bridge_registry_requests_total{route,method,status}` — every HTTP
 *   response, labeled by the NORMALIZED route template (`/v1/search`,
 *   `/v1/orgs/{org}/projects/{project}/contracts/{contract}`, …) so label
 *   cardinality stays bounded by the route table, never by request paths;
 * - `bridge_registry_auth_failures_total` — responses with status 401;
 * - `bridge_registry_rate_limited_total{tier}` — responses with status 429;
 * - `bridge_registry_audit_writes_total{outcome}` — audit append outcomes
 *   (`ok` / `failed`), the durability signal for audit item R2.
 *
 * Counters only (no gauges/histograms): the goal is scrape-ready liveness
 * and traffic signals with zero dependencies, not full APM.
 */

/** Metadata for every metric this registry knows how to render. */
interface MetricSpec {
  name: string;
  help: string;
  labels: readonly string[];
}

/** The metric table; `render` emits HELP/TYPE for each of these. */
export const METRIC_SPECS: readonly MetricSpec[] = [
  {
    name: 'bridge_registry_requests_total',
    help: 'HTTP responses served, by normalized route template, method and status code.',
    labels: ['route', 'method', 'status'],
  },
  {
    name: 'bridge_registry_auth_failures_total',
    help: 'Requests rejected with 401 (unauthenticated).',
    labels: [],
  },
  {
    name: 'bridge_registry_rate_limited_total',
    help: 'Requests rejected with 429, by limiter tier (auth = per-IP, publish = per-principal).',
    labels: ['tier'],
  },
  {
    name: 'bridge_registry_audit_writes_total',
    help: 'Audit sink append outcomes (ok / failed); failed means an entry was not durably recorded.',
    labels: ['outcome'],
  },
];

/** Label value type: strings only (Prometheus text format). */
export type MetricLabels = Readonly<Record<string, string>>;

/** Bucket label used for requests that matched no route template. */
export const UNKNOWN_ROUTE_LABEL = 'unknown';
/** Coarse pre-auth bucket: the route was not matched before authentication. */
export const PRE_AUTH_ROUTE_LABEL = '/v1';

export class MetricsRegistry {
  /** Serialized `name{sortedLabels}` → value. */
  private readonly values = new Map<string, number>();

  /** Increment a counter by `by` (default 1). Unknown names are rejected. */
  public inc(name: string, labels: MetricLabels = {}, by = 1): void {
    if (!METRIC_SPECS.some((spec) => spec.name === name)) {
      throw new TypeError(`MetricsRegistry: unknown metric '${name}'`);
    }
    const key = this.key(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  /** Current value of one series (0 when never incremented) — for tests. */
  public value(name: string, labels: MetricLabels = {}): number {
    return this.values.get(this.key(name, labels)) ?? 0;
  }

  /**
   * Render the Prometheus text exposition (deterministic: metrics in table
   * order, series sorted by label string). Only observed series are emitted;
   * every metric always carries its HELP/TYPE header lines.
   */
  public render(): string {
    const lines: string[] = [];
    for (const spec of METRIC_SPECS) {
      lines.push(`# HELP ${spec.name} ${spec.help}`);
      lines.push(`# TYPE ${spec.name} counter`);
      const series = [...this.values.entries()]
        .filter(([key]) => key.startsWith(`${spec.name}{`) || key === spec.name)
        .map(([key, value]) => [key.slice(spec.name.length), value] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [labelText, value] of series) {
        lines.push(`${spec.name}${labelText} ${value}`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  /** Escape a label value per the text exposition format. */
  private static escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  private key(name: string, labels: MetricLabels): string {
    const spec = METRIC_SPECS.find((s) => s.name === name);
    const parts = (spec?.labels ?? []).map((label) => {
      const raw = labels[label];
      return `${label}="${MetricsRegistry.escapeLabel(raw ?? '')}"`;
    });
    return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
  }
}
