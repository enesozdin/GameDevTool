/**
 * Seeded PRNG: xoshiro128** (Blackman & Vigna), seeded through SplitMix32 so any 32-bit
 * seed gives a well-mixed state. Same seed → same sequence on every platform, so
 * simulation runs are reproducible. Not cryptographic.
 */
export interface Random {
  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number;
  /** Uniform float in [0, 1) with 32 bits of precision. */
  next(): number;
}

const INV_2_32 = 1 / 4_294_967_296;

export function createRandom(seed: number): Random {
  // SplitMix32 state expansion.
  let s = seed >>> 0;
  const splitmix = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();
  // The all-zero state is the only invalid one.
  if ((a | b | c | d) === 0) a = 1;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };
  return { nextUint32, next: () => nextUint32() * INV_2_32 };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** Standard normal sample (Box–Muller; one value per call, the pair partner is dropped). */
export function sampleNormal(random: Random): number {
  let u = random.next();
  while (u === 0) u = random.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random.next());
}

/**
 * Poisson(lambda) sample. Inversion for small means (cost ~lambda), normal approximation
 * above 30 where the error is far below Monte Carlo noise.
 */
export function samplePoisson(random: Random, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * sampleNormal(random)));
  let k = 0;
  let p = Math.exp(-lambda);
  let cumulative = p;
  const u = random.next();
  while (u > cumulative && k < 1_000) {
    k++;
    p *= lambda / k;
    cumulative += p;
  }
  return k;
}

/**
 * Binomial(n, p) sample. Direct Bernoulli trials for small n, normal approximation when
 * the variance is large, otherwise inversion (expected cost ~ n·p).
 * `n` may be fractional (a steady-state cycle count); the fraction is one more trial with
 * success probability fraction·p, so the mean stays n·p.
 */
export function sampleBinomial(random: Random, n: number, p: number): number {
  if (!(n > 0) || !(p > 0)) return 0;
  if (p >= 1) return n;
  const whole = Math.floor(n);
  const fraction = n - whole;
  let k = 0;
  if (whole > 0) {
    const variance = whole * p * (1 - p);
    if (whole <= 64) {
      for (let i = 0; i < whole; i++) if (random.next() < p) k++;
    } else if (variance >= 10) {
      k = Math.min(whole, Math.max(0, Math.round(whole * p + Math.sqrt(variance) * sampleNormal(random))));
    } else if (p <= 0.5) {
      k = binomialInversion(random, whole, p);
    } else {
      k = whole - binomialInversion(random, whole, 1 - p);
    }
  }
  if (fraction > 0 && random.next() < fraction * p) k++;
  return k;
}

function binomialInversion(random: Random, n: number, p: number): number {
  const q = 1 - p;
  const ratio = p / q;
  let prob = Math.pow(q, n);
  let cumulative = prob;
  const u = random.next();
  let k = 0;
  while (u > cumulative && k < n) {
    prob *= (ratio * (n - k)) / (k + 1);
    k++;
    cumulative += prob;
  }
  return k;
}
