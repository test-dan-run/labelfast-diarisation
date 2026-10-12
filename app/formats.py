"""Reading and writing label files: RTTM and NeMo JSON.

Everything is converted to and from one internal shape, a list of
``{"id", "start", "end", "speaker", "text", "verified"}`` dicts with times in
seconds. ``verified`` marks a speaker label the user has confirmed; label files
have no such notion, so imported segments start unverified and exports omit it.
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

DEFAULT_SPEAKER = "speaker_0"


class LabelError(ValueError):
    """The label file could not be understood."""


def parse(content: str, audio_name: str = "") -> list[dict]:
    """Parse an RTTM or NeMo JSON label file, detecting which one it is."""
    is_json = content.lstrip().startswith(("{", "["))
    entries = _parse_nemo(content) if is_json else _parse_rttm(content)

    # A label file may cover several recordings; keep the ones for this audio.
    stem = Path(audio_name).stem
    if any(key == stem for key, _ in entries):
        entries = [e for e in entries if e[0] == stem]

    segments = normalise([seg for _, seg in entries])
    if not segments:
        raise LabelError("No segments found in the label file.")
    return segments


def normalise(segments: list[dict], duration: float | None = None) -> list[dict]:
    """Clean up segments: valid times, clipped to the audio, sorted by start."""
    out = []
    for seg in segments:
        start = max(0.0, float(seg["start"]))
        end = float(seg["end"])
        if duration is not None:
            end = min(end, duration)
        if end <= start:
            continue
        out.append(
            {
                "id": seg.get("id") or uuid.uuid4().hex[:8],
                "start": round(start, 3),
                "end": round(end, 3),
                "speaker": str(seg.get("speaker") or DEFAULT_SPEAKER).strip() or DEFAULT_SPEAKER,
                "text": " ".join(str(seg.get("text") or "").split()),
                "verified": bool(seg.get("verified")),
            }
        )
    out.sort(key=lambda s: (s["start"], s["end"]))
    return out


# RTTM ---------------------------------------------------------------------


def _parse_rttm(content: str) -> list[tuple[str, dict]]:
    entries = []
    for number, line in enumerate(content.splitlines(), 1):
        parts = line.split()
        if not parts or parts[0] != "SPEAKER":
            continue
        try:
            start, length = float(parts[3]), float(parts[4])
            speaker = parts[7]
        except (IndexError, ValueError):
            raise LabelError(f"Malformed RTTM line {number}: {line.strip()!r}") from None
        entries.append((parts[1], {"start": start, "end": start + length, "speaker": speaker}))
    return entries


def to_rttm(segments: list[dict], audio_name: str) -> str:
    """RTTM carries speaker turns only, so the transcript is not written."""
    file_id = _token(Path(audio_name).stem) or "audio"
    lines = [
        f"SPEAKER {file_id} 1 {s['start']:.3f} {s['end'] - s['start']:.3f} "
        f"<NA> <NA> {_token(s['speaker']) or DEFAULT_SPEAKER} <NA> <NA>"
        for s in segments
    ]
    return "\n".join(lines) + "\n" if lines else ""


def _token(value: str) -> str:
    """RTTM fields are whitespace separated, so they cannot contain any."""
    return re.sub(r"\s+", "_", value.strip())


# NeMo JSON ----------------------------------------------------------------


def _parse_nemo(content: str) -> list[tuple[str, dict]]:
    """Accept the JSON flavours NeMo reads and writes.

    * manifest: one JSON object per line with ``offset``/``duration``/``text``
    * diarisation-with-ASR output: one object with ``sentences`` (or ``words``)
    * SegLST: a list of objects with ``start_time``/``end_time``/``words``
    """
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        data = []
        for number, line in enumerate(content.splitlines(), 1):
            if not line.strip():
                continue
            try:
                data.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise LabelError(f"Invalid JSON on line {number}: {exc.msg}") from None

    if isinstance(data, dict):
        session = data.get("session_id")
        if isinstance(data.get("sentences"), list):
            data = [dict(item, session_id=session) for item in data["sentences"] if isinstance(item, dict)]
        elif isinstance(data.get("words"), list):
            data = [dict(item, session_id=session) for item in _join_words(data["words"])]
        else:
            data = [data]

    entries = []
    for item in data:
        if not isinstance(item, dict):
            raise LabelError("Expected JSON objects describing segments.")
        segment = _nemo_segment(item)
        if segment:
            entries.append((_nemo_key(item), segment))
    return entries


def _nemo_segment(item: dict) -> dict | None:
    try:
        if item.get("start_time") is not None and item.get("end_time") is not None:
            start, end = float(item["start_time"]), float(item["end_time"])
        elif item.get("duration") is not None:
            start = float(item.get("offset") or 0)
            end = start + float(item["duration"])
        else:
            return None
    except (TypeError, ValueError):
        raise LabelError(f"Invalid segment times in {json.dumps(item)[:120]}") from None

    text = next((item[k] for k in ("text", "sentence", "words", "word") if isinstance(item.get(k), str)), "")
    if text.strip() == "-":  # NeMo's placeholder for "no transcript"
        text = ""
    speaker = next((item[k] for k in ("speaker", "speaker_label", "speaker_id") if item.get(k) is not None), "")
    return {"start": start, "end": end, "speaker": speaker, "text": text}


def _nemo_key(item: dict) -> str:
    if item.get("audio_filepath"):
        return Path(str(item["audio_filepath"]).replace("\\", "/")).stem
    return str(item.get("session_id") or "")


def _join_words(words: list) -> list[dict]:
    """Group a word-level list into one segment per run of the same speaker."""
    runs: list[dict] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        speaker = word.get("speaker", word.get("speaker_label"))
        if runs and runs[-1]["speaker"] == speaker:
            runs[-1]["end_time"] = word.get("end_time")
            runs[-1]["text"] += " " + str(word.get("word", ""))
        else:
            runs.append(
                {
                    "speaker": speaker,
                    "start_time": word.get("start_time"),
                    "end_time": word.get("end_time"),
                    "text": str(word.get("word", "")),
                }
            )
    return runs


def to_nemo(segments: list[dict], audio_name: str) -> str:
    """NeMo manifest: one JSON object per line, one line per segment."""
    lines = [
        json.dumps(
            {
                "audio_filepath": audio_name,
                "offset": s["start"],
                "duration": round(s["end"] - s["start"], 3),
                "text": s["text"],
                "speaker": s["speaker"],
            },
            ensure_ascii=False,
        )
        for s in segments
    ]
    return "\n".join(lines) + "\n" if lines else ""
