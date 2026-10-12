# labelfast

A small web app for annotating speech recordings: who spoke when, and what they said.
Upload an audio file and label it from scratch, or load pseudo-labels (`.rttm` or NeMo `.json`) and correct them.

It is built for one person on their own machine. There are no accounts and no access control.

## Run

```sh
docker compose up -d --build
```

Then open <http://localhost:8765>.

| Setting | Default | Meaning |
| --- | --- | --- |
| `LABELFAST_PORT` | `8765` | Port on the host |
| `LABELFAST_BIND` | `127.0.0.1` | Address on the host. `0.0.0.0` makes the app reachable by anyone on your network |

Set them in the shell or in a `.env` file next to `docker-compose.yml`.

Projects live in the `labelfast-data` Docker volume, so they survive rebuilds and restarts.
`docker compose down -v` deletes them.

## Use

1. On the home page, choose an audio file. Optionally add a label file to start from. Any format ffmpeg can decode works.
2. In the editor, each speaker has a lane under the waveform and each segment has a row in the list below.
3. Changes save by themselves. Export with the buttons at the top right.

Labels can also be loaded later with **Import labels**, or by dropping a label file onto the editor. That replaces the current segments (Ctrl+Z brings them back).

### Relabelling speakers

You do not have to fix every speaker label by hand. Verify a few segments per speaker, and the app works out the rest by voice.

1. Mark segments whose speaker you are sure of. Press `V` if the label is already right, or assign the right speaker with `1`–`9`, which verifies it too. Verified segments show a ✓ and are drawn solid in the timeline.
2. Press `R`, or click **Relabel speakers**. Each unverified segment is compared with the verified ones and given the speaker it sounds most like.
3. Check the result, verify more where it went wrong, and relabel again. One Ctrl+Z undoes a whole relabel.

Verified segments are never changed. A segment is also left alone when it does not sound enough like any verified speaker, or is shorter than 0.4 s. So a speaker with no verified segment yet keeps their existing labels instead of being merged into someone else.

Two or three verified segments of a couple of seconds each per speaker is a good start. The first run on a recording takes a few seconds per ten minutes of speech. Later runs are near instant, because the voice analysis of each segment is kept.

The verified mark lives in the project only. Neither export format includes it.

### Hotkeys

Press `?` in the editor for the full list.

| Key | Action |
| --- | --- |
| `Enter` / `Shift+Enter` | Next / previous segment, with its text ready to type |
| `Tab` | Play / pause |
| `Shift+Tab` | Replay the segment |
| `Esc` | Leave the text field |
| `1`–`9` | Assign speaker, and mark it verified |
| `V` | Mark the speaker as verified, or undo that |
| `R` | Relabel unverified segments from the verified ones |
| `N` | New segment at the playhead |
| `[` / `]` | Set segment start / end to the playhead |
| `S` / `M` / `X` | Split / merge with next / delete |

The keys in the lower half work on their own outside a text field. While typing, hold `Alt` (`Alt+2`, `Alt+S`, ...).

With the mouse: click the timeline to seek, drag to draw a segment, drag a segment's edge to resize it, double-click a segment to play it, and click a speaker name to rename it.

## Formats

**RTTM** holds speaker turns only. Importing gives segments with empty text. Exporting drops the transcript, and spaces in speaker names become underscores.

```
SPEAKER meeting 1 0.500 3.000 <NA> <NA> speaker_0 <NA> <NA>
```

**NeMo JSON** is exported as a NeMo manifest: one JSON object per line, one line per segment.
`audio_filepath` is the name of the uploaded file, so point it at the real location before training.

```json
{"audio_filepath": "meeting.wav", "offset": 0.5, "duration": 3.0, "text": "good morning", "speaker": "speaker_0"}
```

Import accepts three NeMo layouts and detects which one it has been given:

- a manifest, as above (`offset`, `duration`, `text`, optional `speaker`)
- the diarisation-with-ASR output written next to the predicted RTTM (`sentences`, or `words` when there are no sentences)
- SegLST, a list of objects with `start_time`, `end_time`, `words` and `speaker`

If a label file covers several recordings, only the entries whose file name matches the uploaded audio are used.

## How it works

- `app/main.py`: FastAPI server with the JSON API. It also serves the front end.
- `app/audio.py`: converts each upload to 16-bit WAV with ffmpeg and computes the waveform. WAV keeps seeking exact, at the cost of disk space (about 115 MB per hour of 16 kHz mono).
- `app/formats.py`: RTTM and NeMo JSON import and export.
- `app/speakers.py`: speaker relabelling. It computes a voice embedding per segment with NVIDIA's TitaNet-small model, run on the CPU through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), and matches unverified segments to the verified ones.
- `app/static/`: the front end, plain HTML, CSS and JavaScript with no build step.

Each project is a folder under `/data/projects/<id>/` holding `audio.wav`, `peaks.bin`, `segments.json` and `meta.json`, plus `embeddings.npz` once speakers have been relabelled.

The speaker model (40 MB) is downloaded when the image is built. To use a different one, mount any speaker embedding model that sherpa-onnx supports and point `LABELFAST_SPEAKER_MODEL` at it. The matching threshold in `app/speakers.py` was tuned for TitaNet-small and will need checking for another model.

### Develop without Docker

Needs Python 3.12 and ffmpeg.

```sh
python -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
curl -L -o speaker.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
LABELFAST_DATA=./data LABELFAST_SPEAKER_MODEL=./speaker.onnx .venv/bin/uvicorn app.main:app --reload
.venv/bin/python -m pytest
```
