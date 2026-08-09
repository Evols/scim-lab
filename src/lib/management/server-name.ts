import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "agile",
  "amber",
  "autumn",
  "bold",
  "bright",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "eager",
  "gentle",
  "golden",
  "hidden",
  "lively",
  "lucky",
  "misty",
  "modern",
  "quiet",
  "rapid",
  "silver",
  "solar",
  "steady",
  "swift",
  "vivid",
  "warm",
  "wild",
] as const;

const NOUNS = [
  "badger",
  "beacon",
  "cedar",
  "cloud",
  "comet",
  "falcon",
  "forest",
  "harbor",
  "heron",
  "maple",
  "meadow",
  "moon",
  "nebula",
  "oak",
  "orbit",
  "otter",
  "panda",
  "pine",
  "quasar",
  "raven",
  "reef",
  "ridge",
  "river",
  "sparrow",
  "star",
  "summit",
  "tiger",
  "valley",
  "wave",
  "willow",
] as const;

type RandomInteger = (max: number) => number;

export function generated_server_name(random_integer: RandomInteger = randomInt): string {
  const adjective = ADJECTIVES[random_integer(ADJECTIVES.length)];
  const noun = NOUNS[random_integer(NOUNS.length)];
  const suffix = String(random_integer(1_000_000)).padStart(6, "0");
  return `${adjective}-${noun}-${suffix}`;
}
