/**
 * ULID ids (https://github.com/ulid/spec): 48-bit millisecond timestamp + 80 random bits,
 * Crockford base32, 26 chars. Lexicographic order == creation order, which keeps sorted
 * output stable and merges readable. Monotonic: ids made in the same millisecond (or after
 * the clock moves backwards) increment the random part instead of re-rolling it.
 *
 * Core has no DOM or Node globals, so the clock and the random source are injected.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface IdGeneratorDeps {
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number;
  /** Fills the array with cryptographically strong random bytes (e.g. crypto.getRandomValues). */
  readonly fillRandom: (bytes: Uint8Array<ArrayBuffer>) => void;
}

export type IdGenerator = () => string;

export function createIdGenerator(deps: IdGeneratorDeps): IdGenerator {
  // Random part kept as 16 base32 digits (0..31) so incrementing is a simple carry loop.
  const random = new Uint8Array(RANDOM_CHARS);
  let lastTime = -1;

  return () => {
    let time = Math.floor(deps.now());
    if (!(time >= 0 && time <= MAX_TIME)) throw new RangeError("ULID: timestamp out of range");

    if (time > lastTime) {
      deps.fillRandom(random);
      // 256 is a multiple of 32, so masking keeps the digits uniform.
      for (let i = 0; i < RANDOM_CHARS; i++) random[i] = random[i]! & 31;
      lastTime = time;
    } else {
      time = lastTime;
      let i = RANDOM_CHARS - 1;
      while (i >= 0 && random[i] === 31) random[i--] = 0;
      if (i < 0) throw new RangeError("ULID: random part overflow within one millisecond");
      random[i]!++;
    }

    let timePart = "";
    let t = time;
    for (let i = 0; i < TIME_CHARS; i++) {
      timePart = ALPHABET[t % 32] + timePart;
      t = Math.floor(t / 32);
    }
    let randomPart = "";
    for (let i = 0; i < RANDOM_CHARS; i++) randomPart += ALPHABET[random[i]!];
    return timePart + randomPart;
  };
}

/** Decodes the creation time (ms since epoch) of a valid ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < TIME_CHARS; i++) t = t * 32 + ALPHABET.indexOf(id[i]!);
  return t;
}
