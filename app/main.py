"""labelfast: a single-user transcription and diarisation annotation server."""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import audio as audio_tools
from . import formats

DATA_DIR = Path(os.environ.get("LABELFAST_DATA", "/data"))
PROJECTS = DATA_DIR / "projects"
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="labelfast")


class Segment(BaseModel):
    id: str
    start: float
    end: float
    speaker: str
    text: str = ""


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, obj) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _project_dir(project_id: str) -> Path:
    path = PROJECTS / project_id
    if not re.fullmatch(r"[0-9a-f]{12}", project_id) or not (path / "meta.json").is_file():
        raise HTTPException(404, "Project not found.")
    return path


def _parse_labels(upload: UploadFile, audio_name: str, duration: float | None = None) -> list[dict]:
    try:
        content = upload.file.read().decode("utf-8-sig")
        return formats.normalise(formats.parse(content, audio_name), duration)
    except UnicodeDecodeError:
        raise HTTPException(400, "The label file is not UTF-8 text.") from None
    except formats.LabelError as exc:
        raise HTTPException(400, str(exc)) from None


@app.get("/api/projects")
def list_projects() -> list[dict]:
    metas = [_read(p) for p in PROJECTS.glob("*/meta.json")]
    return sorted(metas, key=lambda m: m["updated"], reverse=True)


@app.post("/api/projects")
def create_project(audio: UploadFile = File(...), labels: UploadFile | None = File(None)) -> dict:
    audio_name = Path((audio.filename or "audio").replace("\\", "/")).name
    # Parse the labels first: a bad label file should fail before the slow part.
    segments = _parse_labels(labels, audio_name) if labels else []

    project_id = uuid.uuid4().hex[:12]
    path = PROJECTS / project_id
    path.mkdir(parents=True)
    try:
        source = path / ("source" + Path(audio_name).suffix)
        with source.open("wb") as f:
            shutil.copyfileobj(audio.file, f)
        duration = audio_tools.prepare(source, path / "audio.wav", path / "peaks.bin")
        source.unlink()

        segments = formats.normalise(segments, duration)
        now = time.time()
        meta = {
            "id": project_id,
            "name": audio_name,
            "duration": duration,
            "peaks_per_sec": audio_tools.PEAKS_PER_SEC,
            "segments": len(segments),
            "created": now,
            "updated": now,
        }
        _write(path / "segments.json", segments)
        _write(path / "meta.json", meta)  # written last: it marks the project as complete
    except audio_tools.AudioError as exc:
        shutil.rmtree(path, ignore_errors=True)
        raise HTTPException(400, str(exc)) from None
    except BaseException:
        shutil.rmtree(path, ignore_errors=True)
        raise
    return meta


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    path = _project_dir(project_id)
    return {"project": _read(path / "meta.json"), "segments": _read(path / "segments.json")}


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    shutil.rmtree(_project_dir(project_id))


@app.put("/api/projects/{project_id}/segments", status_code=204)
def save_segments(project_id: str, segments: list[Segment]) -> None:
    path = _project_dir(project_id)
    meta = _read(path / "meta.json")
    cleaned = formats.normalise([s.model_dump() for s in segments], meta["duration"])
    _write(path / "segments.json", cleaned)
    _write(path / "meta.json", meta | {"segments": len(cleaned), "updated": time.time()})


@app.post("/api/projects/{project_id}/labels")
def parse_labels(project_id: str, labels: UploadFile = File(...)) -> list[dict]:
    """Parse a label file against this project. The client decides whether to keep it."""
    meta = _read(_project_dir(project_id) / "meta.json")
    return _parse_labels(labels, meta["name"], meta["duration"])


@app.get("/api/projects/{project_id}/audio")
def get_audio(project_id: str) -> FileResponse:
    return FileResponse(_project_dir(project_id) / "audio.wav", media_type="audio/wav")


@app.get("/api/projects/{project_id}/peaks")
def get_peaks(project_id: str) -> FileResponse:
    return FileResponse(_project_dir(project_id) / "peaks.bin", media_type="application/octet-stream")


@app.get("/api/projects/{project_id}/export")
def export(project_id: str, format: str) -> Response:
    path = _project_dir(project_id)
    name = _read(path / "meta.json")["name"]
    segments = _read(path / "segments.json")
    if format == "rttm":
        body, ext, media_type = formats.to_rttm(segments, name), "rttm", "text/plain"
    elif format == "nemo":
        body, ext, media_type = formats.to_nemo(segments, name), "json", "application/json"
    else:
        raise HTTPException(400, "format must be 'rttm' or 'nemo'.")
    filename = quote(f"{Path(name).stem or 'labels'}.{ext}")
    return Response(
        body,
        media_type=f"{media_type}; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
