#!/usr/bin/env python3
"""Algorithmic sound for the project page's toss animation (web/home/toss.ts).

Pure code, standard library only, fixed seed: the same WAV every run.
One loop of the 4.2 s animation, in step with it:
  - a breathy whoosh that pans left → right as the chunks fly the arc,
  - a plucked note (Karplus-Strong) as each chunk leaves, and a higher one as
    it lands, from a pentatonic scale so any overlap stays consonant,
  - a soft major chime when the file is whole again (the SHA-256 check).
Anything that rings past the end wraps round to the start, so the loop is
seamless.

    python3 scripts/toss_sound.py web/home/toss.wav
"""

import math
import random
import struct
import sys
import wave

RATE = 22050
PERIOD = 4.2  # seconds; must match PERIOD in web/home/toss.ts
CHUNKS = 26  # must match CHUNKS in web/home/toss.ts
N = int(RATE * PERIOD)
rng = random.Random(7)

left = [0.0] * N
right = [0.0] * N


def add(i, value, pan):
    """Mix a sample in at i (wrapping), pan 0 = left … 1 = right (equal power)."""
    j = i % N
    left[j] += value * math.cos(pan * math.pi / 2)
    right[j] += value * math.sin(pan * math.pi / 2)


def smooth(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


def pluck(start, freq, gain, pan, seconds=1.2):
    """Karplus-Strong string: a burst of noise through a decaying delay line."""
    period = max(2, int(RATE / freq))
    line = [rng.uniform(-1, 1) for _ in range(period)]
    for n in range(int(seconds * RATE)):
        k = n % period
        nxt = 0.996 * 0.5 * (line[k] + line[(k + 1) % period])
        add(start + n, line[k] * gain, pan)
        line[k] = nxt


def chime(start, freqs, gain, pan, seconds=2.4):
    for n in range(int(seconds * RATE)):
        t = n / RATE
        env = min(1.0, t / 0.01) * math.exp(-t * 2.2)
        v = sum(math.sin(2 * math.pi * f * t) + 0.25 * math.sin(4 * math.pi * f * t) for f in freqs)
        add(start + n, v * env * gain / len(freqs), pan)


# A minor pentatonic across two octaves: departures low, arrivals high.
SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99]

# The chunks, timed like the vertex shader: chunk i leaves at (i/CHUNKS)*0.35
# of the loop and takes 0.55 of it to fly. Every other chunk sounds.
for i in range(0, CHUNKS, 2):
    leave = (i / CHUNKS) * 0.35
    land = leave + 0.55
    pluck(int(leave * N), SCALE[i % 5], 0.16, 0.12)
    pluck(int(land * N), SCALE[5 + (i * 3) % 5], 0.12, 0.88, seconds=0.9)

# The whoosh: noise through a one-pole low-pass whose cutoff rises and falls
# with the flight, panned along the arc.
state = 0.0
for n in range(N):
    u = n / N
    flight = smooth((u - 0.02) / 0.3) * (1 - smooth((u - 0.62) / 0.3))
    cutoff = 300 + 2600 * flight
    a = 1 - math.exp(-2 * math.pi * cutoff / RATE)
    state += a * (rng.uniform(-1, 1) - state)
    add(n, state * 0.22 * flight, 0.1 + 0.8 * smooth((u - 0.05) / 0.85))

# Whole again: A major (A5, C#6, E6), just after the last chunk lands.
chime(int(0.91 * N), [880.0, 1108.73, 1318.51], 0.3, 0.85)

# Normalise with headroom and write 16-bit stereo.
peak = max(max(abs(x) for x in left), max(abs(x) for x in right)) or 1.0
scale = 0.7 / peak
out = sys.argv[1] if len(sys.argv) > 1 else "toss.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(
        b"".join(
            struct.pack("<hh", int(left[n] * scale * 32767), int(right[n] * scale * 32767))
            for n in range(N)
        )
    )
print(f"wrote {out}: {PERIOD}s, {RATE} Hz stereo, peak scaled {scale:.3f}")
