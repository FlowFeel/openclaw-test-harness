/**
 * Deterministic Clock & ID providers — Design-for-Testability (DFT) primitives.
 *
 * Replaces direct Date.now() / Math.random() calls in test payloads with
 * injectable providers so parallel test suites yield fixed timestamps and
 * incrementing counter IDs. Eliminates timing flakiness and ID collisions
 * across concurrent test workers.
 *
 * @invariants
 * - SystemClock.now() delegates to Date.now() (production).
 * - DeterministicTestClock.now() returns a fixed, advanceable time.
 * - SequenceGenerator.nextId() returns a strictly incrementing counter.
 * - All providers are monomorphic (fixed shape) to preserve V8 hidden classes.
 */

/** Clock protocol — injectable time source. */
export interface Clock {
  now(): number
}

/** Production clock — delegates to the system wall clock. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

/**
 * Deterministic clock for tests. Returns a fixed time that only advances on
 * explicit advance() calls — no wall-clock drift between assertions.
 */
export class DeterministicTestClock implements Clock {
  currentTime: number

  constructor(initialTime: number = 1700000000000) {
    this.currentTime = initialTime
  }

  now(): number {
    return this.currentTime
  }

  /** Advance the fixed time by ms milliseconds. */
  advance(ms: number): void {
    this.currentTime += ms
  }

  /** Set the fixed time to an absolute value. */
  advanceTo(time: number): void {
    this.currentTime = time
  }
}

/**
 * Deterministic monotonic ID generator. Replaces Date.now()+Math.random()
 * patterns with a collision-free incrementing counter — deterministic across
 * parallel test suites and friendlier to V8 inline caches (no float math).
 */
export class SequenceGenerator {
  private counter: number

  constructor(seed: number = 0) {
    this.counter = seed
  }

  nextId(): number {
    return ++this.counter
  }

  /** Reset the counter (for test isolation). */
  reset(seed: number = 0): void {
    this.counter = seed
  }
}
