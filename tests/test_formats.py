import json

import pytest

from app import formats

RTTM = """\
SPEAKER meeting 1 0.500 2.000 <NA> <NA> speaker_1 <NA> <NA>
SPEAKER meeting 1 0.000 1.250 <NA> <NA> speaker_0 <NA> <NA>
SPEAKER other 1 9.000 1.000 <NA> <NA> speaker_9 <NA> <NA>
"""


def spans(segments):
    return [(s["start"], s["end"], s["speaker"], s["text"]) for s in segments]


def test_rttm_keeps_only_the_matching_recording_sorted_by_start():
    assert spans(formats.parse(RTTM, "meeting.wav")) == [
        (0.0, 1.25, "speaker_0", ""),
        (0.5, 2.5, "speaker_1", ""),
    ]


def test_rttm_keeps_everything_when_no_recording_matches():
    assert len(formats.parse(RTTM, "unrelated.wav")) == 3


def test_nemo_manifest_lines():
    manifest = "\n".join(
        [
            json.dumps({"audio_filepath": "/data/a.wav", "offset": 1.0, "duration": 2.0, "text": "hello there", "speaker": "A"}),
            json.dumps({"audio_filepath": "/data/a.wav", "offset": 4.0, "duration": 1.5, "text": "-"}),
            json.dumps({"audio_filepath": "/data/a.wav", "offset": 0, "duration": None, "rttm_filepath": "a.rttm"}),
        ]
    )
    assert spans(formats.parse(manifest, "a.wav")) == [
        (1.0, 3.0, "A", "hello there"),
        (4.0, 5.5, formats.DEFAULT_SPEAKER, ""),
    ]


def test_nemo_diarisation_output_sentences():
    output = {
        "session_id": "a",
        "words": [{"word": "hi", "start_time": 0.1, "end_time": 0.3, "speaker": "speaker_0"}],
        "sentences": [{"speaker": "speaker_0", "start_time": 0.1, "end_time": 0.3, "text": "hi"}],
    }
    assert spans(formats.parse(json.dumps(output), "a.wav")) == [(0.1, 0.3, "speaker_0", "hi")]


def test_nemo_diarisation_output_words_are_joined_per_speaker_turn():
    words = [
        {"word": "good", "start_time": 0.0, "end_time": 0.4, "speaker": "speaker_0"},
        {"word": "morning", "start_time": 0.4, "end_time": 0.9, "speaker": "speaker_0"},
        {"word": "hello", "start_time": 1.0, "end_time": 1.4, "speaker": "speaker_1"},
    ]
    assert spans(formats.parse(json.dumps({"words": words}), "a.wav")) == [
        (0.0, 0.9, "speaker_0", "good morning"),
        (1.0, 1.4, "speaker_1", "hello"),
    ]


def test_nemo_seglst():
    seglst = [{"session_id": "a", "speaker": "spk1", "start_time": "2.0", "end_time": "3.5", "words": "ok then"}]
    assert spans(formats.parse(json.dumps(seglst), "a.wav")) == [(2.0, 3.5, "spk1", "ok then")]


def test_normalise_clips_to_the_audio_and_drops_empty_segments():
    segments = [
        {"start": -1, "end": 2, "speaker": "a"},
        {"start": 8, "end": 12, "speaker": "a"},
        {"start": 11, "end": 12, "speaker": "a"},
    ]
    assert spans(formats.normalise(segments, 10.0)) == [(0.0, 2.0, "a", ""), (8.0, 10.0, "a", "")]


@pytest.mark.parametrize("content", ["", "not a label file", "[]", '{"text": "no times"}'])
def test_files_without_segments_are_rejected(content):
    with pytest.raises(formats.LabelError):
        formats.parse(content, "a.wav")


def test_exports_round_trip():
    segments = formats.normalise(
        [
            {"start": 0.0, "end": 1.5, "speaker": "Alice Smith", "text": "héllo"},
            {"start": 1.0, "end": 2.25, "speaker": "bob", "text": "hi"},
        ]
    )
    assert spans(formats.parse(formats.to_nemo(segments, "a b.wav"), "a b.wav")) == spans(segments)
    # RTTM has no transcript, and no spaces inside a field.
    assert spans(formats.parse(formats.to_rttm(segments, "a b.wav"), "a_b.wav")) == [
        (0.0, 1.5, "Alice_Smith", ""),
        (1.0, 2.25, "bob", ""),
    ]
