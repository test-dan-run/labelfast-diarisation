# labelfast

A single-user web app for annotating speech recordings: who spoke when (diarisation) and what they said (transcription). The user uploads audio and labels it from scratch, or loads pseudo-labels and corrects them. It ships as one Docker service.

README.md is the user-facing guide. This file is for working on the code.

## Commands

```sh
docker compose up -d --build        # run; serves http://localhost:8765
docker compose down                 # stop (add -v to delete all projects)

# without Docker (needs Python 3.12 and ffmpeg)
python -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
LABELFAST_DATA=./data .venv/bin/uvicorn app.main:app --reload
.venv/bin/python -m pytest          # format import/export tests
```

The front end is copied into the image at build time, so rebuild (`up -d --build`) after changing anything under `app/`.

Only `app/formats.py` has automated tests. The front end has none in the repo: verify UI changes in a real browser. `state`, `seg()`, `audio` and the other top-level names in `app.js` are reachable from the console or from a Playwright `page.evaluate`, which makes scripted checks straightforward.

## Design principles

1. **One user, one machine.** No accounts, auth, sessions, locking or multi-user conflict handling. Do not add them. The only concession to safety is that the port binds to `127.0.0.1` by default.
2. **Minimal.** No front-end framework, no build step, no JS dependencies, no CDN. The server has four Python dependencies. Prefer a few lines of plain code over a library, and leave out options nobody asked for.
3. **Keyboard first.** The core loop (listen, fix text, fix speaker, next) must be doable without the mouse. A new editing action needs a hotkey and a line in the help dialog.
4. **Nothing is lost.** Edits autosave, every destructive action is undoable, and bulk replacement (import) goes through undo rather than a confirmation prompt.
5. **Fast on long recordings.** The reference case is a one-hour file with about 1,700 segments. Edits there take under 10 ms and must stay that way.
6. **Formats stay at the edge.** RTTM and NeMo JSON are converted to one internal segment shape on the way in and out. Nothing else in the app knows about them.

## Layout

| Path | Role |
| --- | --- |
| `app/main.py` | FastAPI app: JSON API, file storage, serves the front end |
| `app/audio.py` | ffmpeg: transcode to WAV, compute waveform peaks |
| `app/formats.py` | RTTM and NeMo JSON parsing and export |
| `app/static/index.html` | Markup for both views, the help dialog |
| `app/static/app.js` | All front-end logic, one file, sectioned by comment banners |
| `app/static/style.css` | Styles, light and dark via CSS variables |
| `tests/test_formats.py` | Tests for `formats.py` |

## Data model

A segment is `{id, start, end, speaker, text}`, times in seconds rounded to 3 decimals. Segments are kept sorted by `(start, end)`. Overlap is allowed, since speakers talk over each other.

Each project is a folder `/data/projects/<12-hex id>/`:

- `audio.wav`: the playback copy
- `peaks.bin`: int8 `(min, max)` pairs, 100 per second
- `segments.json`: the list of segments
- `meta.json`: name, duration, segment count, timestamps. It is written last on creation, so its presence marks a complete project.

The client holds the whole segment list and saves it whole with one `PUT`. The server runs it through `formats.normalise` (clip to the audio, drop empty segments, sort) before writing.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/projects` | List projects, newest first |
| `POST /api/projects` | Create from multipart `audio` and optional `labels` |
| `GET /api/projects/{id}` | Metadata and segments |
| `DELETE /api/projects/{id}` | Delete |
| `PUT /api/projects/{id}/segments` | Save the full segment list |
| `POST /api/projects/{id}/labels` | Parse a label file and return segments. Does not save |
| `GET /api/projects/{id}/audio` | WAV, with range requests |
| `GET /api/projects/{id}/peaks` | Waveform peaks, binary |
| `GET /api/projects/{id}/export?format=rttm\|nemo` | Download labels |

## Features

**Projects**
- Upload any audio ffmpeg can decode, with or without a label file.
- Home page lists projects with duration, segment count and date, and can delete them.
- Drag and drop: audio and labels onto the home page, labels onto the editor.

**Editor**
- Waveform timeline with a ruler, one lane per speaker, and a minimap scrollbar.
- Segment list below: time range (click to play), speaker chip (click for a menu), auto-growing text box.
- Click to seek, drag to draw a segment, drag an edge to resize, double-click to play a segment.
- The selected segment is highlighted on the waveform, and its edges can be dragged there.
- Playback stops at the end of the selected segment. Speed control from 0.5× to 2×. Optional auto-play on navigation.
- Zoom with `+`/`−`, the buttons, or Ctrl+scroll. Scroll moves the timeline. The view follows the playhead.
- Speakers: assign by number, add new ones, rename by clicking the lane label. Renaming onto an existing name merges the two.
- Split (at the playhead, and at the text cursor when typing), merge with next, delete, new segment at the playhead, set start or end to the playhead.
- Undo and redo, 100 steps, covering every edit including import.
- Autosave 700 ms after the last change, with a status indicator. Ctrl+S saves immediately.
- Light and dark themes follow the system setting.

**Formats**
- Import detects the format from the content, not the extension.
- RTTM in and out. RTTM has no transcript field, so export drops the text and replaces spaces in names with underscores.
- NeMo JSON export is a manifest: one object per line with `audio_filepath`, `offset`, `duration`, `text`, `speaker`.
- NeMo JSON import accepts a manifest, the diarisation-with-ASR output (`sentences`, else `words` grouped per speaker turn), and SegLST.
- A label file covering several recordings is filtered to the entries matching the uploaded file's name. If none match, all are used.

## Hotkeys

The rule: `Enter`, `Tab` and `Esc` always work. Editing keys work bare outside a text field and with `Alt` inside one. A third group works only outside a text field, because those keys are needed for typing.

| Key | Action |
| --- | --- |
| `Enter` / `Shift+Enter` | Next / previous segment, focusing its text. Outside a text field, `Enter` first focuses the selected segment |
| `Tab` / `Shift+Tab` | Play-pause / replay the segment |
| `Esc` | Leave the text field |
| `1`–`9` | Assign speaker. The first unused number adds a speaker |
| `N` | New 2-second segment at the playhead |
| `[` / `]` | Set start / end to the playhead |
| `S` / `M` / `X` | Split / merge with next / delete |
| `Space` | Play-pause (outside text) |
| `↑` / `↓` | Previous / next segment without focusing text (outside text) |
| `←` / `→` | Seek 1 s, 5 s with Shift (outside text) |
| `+` / `−` | Zoom (outside text) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo (outside text; inside, the browser's own text undo applies) |
| `?` | Help |

Keep the help dialog in `index.html` and the table in README.md in step with the handler at the bottom of `app.js`.

## Things to preserve

- **`renderList` reuses rows by segment id.** Rebuilding every row took 170 ms on the reference case, reset the scroll position and dropped keyboard focus. The keyed version takes 8 ms. Do not replace it with a full re-render.
- **Hotkeys match on `e.code`, not `e.key`,** so `Alt` combinations work on macOS, where Option changes the character typed. The handler also returns early during IME composition, which matters for CJK transcripts where Enter confirms a candidate.
- **Audio is always transcoded to 16-bit WAV.** Compressed formats do not seek accurately in browsers, and segment boundaries depend on exact seeking. The cost is disk space, about 115 MB per hour of 16 kHz mono.
- **Peaks are computed on the server.** The browser never decodes the whole file, so long recordings open at once and play through range requests.
- **`pushUndo()` goes before the mutation,** and `touch()` after it. For text, one undo step is taken per visit to a text box.
- **Timeline geometry lives in `app.js`** (`RULER_H`, `WAVE_H`, `LANE_H`) and reaches the CSS through the `--head` and `--lane` variables, so the lane labels line up with the canvas.
- **User-supplied strings go into the DOM as text,** through the `h()` helper, never as HTML.
- **Exports read from disk,** so the client awaits `save()` before starting a download.
