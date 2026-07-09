/**
 * Lightweight server telemetry. Every scaling claim should be a measurement:
 * this samples tick durations into a ring buffer and counts the traffic that
 * matters (snapshot bytes, messages), then renders one summary line.
 *
 * Zero external dependencies, negligible overhead — always on.
 */
export class ServerStats {
  private readonly tickMs: Float32Array;
  private tickIdx = 0;
  private tickCount = 0;

  bytesOut = 0;
  messagesIn = 0;
  private windowStart = Date.now();

  constructor(sampleWindow = 1200) {
    this.tickMs = new Float32Array(sampleWindow);
  }

  recordTick(ms: number): void {
    this.tickMs[this.tickIdx] = ms;
    this.tickIdx = (this.tickIdx + 1) % this.tickMs.length;
    if (this.tickCount < this.tickMs.length) this.tickCount++;
  }

  /** Percentiles over the sampled window. */
  tickPercentiles(): { p50: number; p99: number; max: number } {
    if (this.tickCount === 0) return { p50: 0, p99: 0, max: 0 };
    const sorted = Array.from(this.tickMs.subarray(0, this.tickCount)).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] };
  }

  /** One-line summary. `reset` starts a new traffic window (periodic logging). */
  report(extra: { sessions: number; zones: number; entities: number }, reset = true): string {
    const { p50, p99, max } = this.tickPercentiles();
    const secs = Math.max(1, (Date.now() - this.windowStart) / 1000);
    const line =
      `[stats] tick p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms | ` +
      `${extra.sessions} sessions, ${extra.zones} zones, ${extra.entities} entities | ` +
      `out ${(this.bytesOut / secs / 1024).toFixed(1)} KiB/s, in ${(this.messagesIn / secs).toFixed(0)} msg/s`;
    if (reset) {
      this.bytesOut = 0;
      this.messagesIn = 0;
      this.windowStart = Date.now();
    }
    return line;
  }
}
