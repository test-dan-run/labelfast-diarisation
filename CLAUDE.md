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
.venv/bin/python -m pytest          # format and speaker-matching tests
```

The front end is copied into the image at build time, so rebuild (`up -d --build`) after changing anything under `app/`.

Only `app/formats.py` and the matching logic in `app/speakers.py` have automated tests. Relabelling for real needs the speaker model, which the image downloads at build time (README.md has the command for running without Docker). The front end has no tests in the repo: verify UI changes in a real browser. `state`, `seg()`, `audio` and the other top-level names in `app.js` are reachable from the console or from a Playwright `page.evaluate`, which makes scripted checks straightforward.

## Design principles

1. **One user, one machine.** No accounts, auth, sessions, locking or multi-user conflict handling. Do not add them. The only concession to safety is that the port binds to `127.0.0.1` by default.
2. **Minimal.** No front-end framework, no build step, no JS dependencies, no CDN. The server has five Python dependencies, and the fifth (sherpa-onnx, for speaker embeddings) is only imported when relabelling runs. Prefer a few lines of plain code over a library, and leave out options nobody asked for.
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
| `app/speakers.py` | Speaker relabelling: embeddings, profiles from verified segments, matching |
| `app/static/index.html` | Markup for both views, the help dialog |
| `app/static/app.js` | All front-end logic, one file, sectioned by comment banners |
| `app/static/style.css` | Styles, light and dark via CSS variables |
| `tests/test_formats.py` | Tests for `formats.py` |
| `tests/test_speakers.py` | Tests for the matching in `speakers.py`, with hand-made vectors and no model |

## Data model

A segment is `{id, start, end, speaker, text, verified}`, times in seconds rounded to 3 decimals. Segments are kept sorted by `(start, end)`. Overlap is allowed, since speakers talk over each other.

`verified` means the user has confirmed the speaker label. It is internal: imported segments start unverified and neither export format carries it.

Each project is a folder `/data/projects/<12-hex id>/`:

- `audio.wav`: the playback copy
- `peaks.bin`: int8 `(min, max)` pairs, 100 per second
- `segments.json`: the list of segments
- `meta.json`: name, duration, segment count, timestamps. It is written last on creation, so its presence marks a complete project.
- `embeddings.npz`: cached voice embeddings, keyed by segment times. Created on the first relabel. Safe to delete.

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
| `POST /api/projects/{id}/relabel` | Propose speakers for unverified segments, from the saved segments. Does not save |
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

**Speaker relabelling**
- A segment's speaker can be marked verified, with `V` or by assigning a speaker by hand. Verified segments show a ✓ in the list and are drawn solid in the timeline. The count is shown next to the segment total.
- Relabel (`R` or the button) gives every unverified segment the verified speaker it sounds most like. Verified segments are never changed.
- A segment stays as it is when its best match scores under the threshold or it is shorter than 0.4 s. This keeps speakers with no verified example from being absorbed into others.
- Embeddings are cached per project, so only the first run on a recording is slow (about 6 s for 14 minutes of speech), and a moved boundary costs one new embedding.
- The proposals are applied on the client as a single undo step. Relabelled segments stay unverified.

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
| `1`–`9` | Assign speaker and mark it verified. The first unused number adds a speaker |
| `V` | Toggle verified on the selected segment |
| `R` | Relabel unverified segments from the verified ones |
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
- **Exports and relabelling read from disk,** so the client awaits `save()` before calling them.
- **Endpoints that compute labels do not save.** Import and relabel both return segments or proposals, and the client applies them through `pushUndo()`. That is what makes them undoable.
- **The relabel threshold (`THRESHOLD` in `speakers.py`) is tuned to the model.** At 0.45 with TitaNet-small, a synthetic 8-speaker test gave no wrong changes in 271 and left a speaker with no verified segments untouched. WeSpeaker ResNet34 through sherpa-onnx scored far worse on the same test (79% against 97% with one verified segment per speaker) and its scores did not separate known from unknown speakers. Re-tune before changing either the model or the number.
- **Only a deliberate act verifies a segment:** `V` or assigning a speaker. Relabelling, importing and drawing a new segment do not, because verified segments are the ground truth everything else is judged against.
