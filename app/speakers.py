"""Speaker relabelling: give unverified segments the speaker they sound like.

Segments the user has verified act as reference recordings of each speaker.
Every segment is turned into a voice embedding, the verified ones are averaged
into one profile per speaker, and each unverified segment is matched to the
closest profile.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np

MODEL = Path(os.environ.get("LABELFAST_SPEAKER_MODEL", "/models/speaker.onnx"))

_RATE = 16000
MIN_LEN = 0.4  # seconds; anything shorter says too little about the voice
_MAX_LEN = 20.0  # seconds of a segment that are listened to

# Cosine similarity a segment needs to its closest speaker before it is
# relabelled. Tuned for TitaNet-small on a synthetic 8-speaker recording: at
# 0.45, 99.8% of the changes were right and under 1% of the segments from
# speakers with no verified example were pulled onto someone else.
THRESHOLD = 0.45

_lock = threading.Lock()
_extractor = None


class SpeakerError(Exception):
    """Relabelling could not be done."""


def relabel(segments: list[dict], wav: Path, cache: Path) -> dict:
    """Propose a speaker for each unverified segment. Nothing is modified."""
    if not any(s["verified"] for s in segments):
        raise SpeakerError("Verify at least one segment first.")
    with _lock:
        vectors = _embed(segments, wav, cache)
    return assign(segments, vectors)


def assign(segments: list[dict], vectors: dict[str, np.ndarray], threshold: float = THRESHOLD) -> dict:
    """Match unverified segments to speaker profiles built from verified ones.

    ``vectors`` maps segment id to a unit-length embedding; segments too short
    to have one are missing. Returns the confident matches as ``labels`` (id to
    speaker) and counts of the segments left alone.
    """
    profiles: dict[str, np.ndarray] = {}
    for s in segments:
        if s["verified"] and s["id"] in vectors:
            # Longer segments describe the voice better, so they count for more.
            weighted = vectors[s["id"]] * (s["end"] - s["start"])
            profiles[s["speaker"]] = profiles.get(s["speaker"], 0) + weighted
    if not profiles:
        raise SpeakerError(f"The verified segments are too short. Verify one of at least {MIN_LEN} s.")
    names = list(profiles)
    matrix = np.stack([p / np.linalg.norm(p) for p in profiles.values()])

    labels, uncertain, too_short = {}, 0, 0
    for s in segments:
        if s["verified"]:
            continue
        if s["id"] not in vectors:
            too_short += 1
            continue
        scores = matrix @ vectors[s["id"]]
        best = int(scores.argmax())
        if scores[best] >= threshold:
            labels[s["id"]] = names[best]
        else:
            uncertain += 1
    return {"labels": labels, "uncertain": uncertain, "too_short": too_short}


def _embed(segments: list[dict], wav: Path, cache_path: Path) -> dict[str, np.ndarray]:
    """Embeddings by segment id, computing only the ones not already cached.

    The cache is keyed by a segment's times, so it survives relabelling and
    text edits and only a moved boundary costs a new embedding.
    """
    cache = _load_cache(cache_path)
    todo = [s for s in segments if _key(s) not in cache and s["end"] - s["start"] >= MIN_LEN]
    if todo:
        extractor = _load_extractor()
        with tempfile.NamedTemporaryFile(dir=wav.parent, suffix=".raw") as raw:
            subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav),
                    "-ac", "1", "-ar", str(_RATE), "-f", "s16le", raw.name,
                ],
                check=True,
            )  # fmt: skip
            samples = np.memmap(raw.name, dtype="<i2", mode="r")  # read from disk a segment at a time
            for s in todo:
                first = int(s["start"] * _RATE)
                last = int(min(s["end"], s["start"] + _MAX_LEN) * _RATE)
                stream = extractor.create_stream()
                stream.accept_waveform(_RATE, samples[first:last].astype(np.float32) / 32768)
                stream.input_finished()
                if not extractor.is_ready(stream):
                    continue
                vector = np.asarray(extractor.compute(stream), dtype=np.float32)
                norm = np.linalg.norm(vector)
                if norm > 0:
                    cache[_key(s)] = vector / norm
            del samples
        # Keep only what the current segments use, so the file does not grow forever.
        _save_cache(cache_path, {_key(s): cache[_key(s)] for s in segments if _key(s) in cache})
    return {s["id"]: cache[_key(s)] for s in segments if _key(s) in cache}


def _key(segment: dict) -> tuple[float, float]:
    return segment["start"], segment["end"]


def _load_extractor():
    global _extractor
    if _extractor is None:
        if not MODEL.is_file():
            raise SpeakerError(f"The speaker model is missing ({MODEL}). See the README for where to get it.")
        import sherpa_onnx  # slow to import, and only relabelling needs it

        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(MODEL), num_threads=min(4, os.cpu_count() or 1))
        _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    return _extractor


def _model_tag() -> str:
    """Identifies the model, so embeddings from a different one are not reused."""
    return f"{MODEL.name}:{MODEL.stat().st_size}" if MODEL.is_file() else ""


def _load_cache(path: Path) -> dict[tuple[float, float], np.ndarray]:
    try:
        with np.load(path) as data:
            if str(data["model"]) != _model_tag():
                return {}
            return {(float(a), float(b)): v for (a, b), v in zip(data["times"], data["vectors"])}
    except (OSError, ValueError, KeyError):
        return {}


def _save_cache(path: Path, cache: dict[tuple[float, float], np.ndarray]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as f:
        np.savez(
            f,
            model=_model_tag(),
            times=np.array(list(cache), dtype=np.float64).reshape(-1, 2),
            vectors=np.array(list(cache.values())),
        )
    os.replace(tmp, path)
