"""Audio preparation with ffmpeg: a browser-friendly WAV and waveform peaks."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

PEAKS_PER_SEC = 100
_PEAK_RATE = 8000  # sample rate the waveform overview is computed at


class AudioError(Exception):
    """The uploaded file could not be decoded as audio."""


def prepare(src: Path, wav: Path, peaks: Path) -> float:
    """Transcode ``src`` for playback, write its peaks, return the duration.

    Everything is converted to 16-bit PCM WAV (mono or stereo, original sample
    rate) so that any input plays in the browser and seeking is sample accurate,
    which compressed formats do not guarantee.
    """
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src),
            "-map", "0:a:0", "-vn", "-af", "aformat=channel_layouts=mono|stereo",
            "-c:a", "pcm_s16le", str(wav),
        ],
        capture_output=True,
    )  # fmt: skip
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip().splitlines()
        raise AudioError("Could not decode audio" + (f": {detail[-1]}" if detail else "."))

    duration = _write_peaks(wav, peaks)
    if duration <= 0:
        raise AudioError("The audio file is empty.")
    return duration


def _write_peaks(wav: Path, out: Path) -> float:
    """Write interleaved int8 (min, max) pairs, PEAKS_PER_SEC of them a second."""
    step = _PEAK_RATE // PEAKS_PER_SEC
    chunk = _PEAK_RATE * 2 * 60  # one minute of 16-bit mono
    proc = subprocess.Popen(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(wav),
            "-ac", "1", "-ar", str(_PEAK_RATE), "-f", "s16le", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )  # fmt: skip
    total = 0
    with out.open("wb") as f:
        while data := proc.stdout.read(chunk):
            samples = np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2")
            total += len(samples)
            samples = np.pad(samples, (0, -len(samples) % step))
            buckets = samples.reshape(-1, step)
            pairs = np.stack([buckets.min(axis=1), buckets.max(axis=1)], axis=1) >> 8
            f.write(pairs.astype(np.int8).tobytes())
    if proc.wait() != 0:
        raise AudioError("Could not read the decoded audio.")
    return total / _PEAK_RATE
