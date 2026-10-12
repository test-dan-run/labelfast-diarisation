import numpy as np
import pytest

from app import speakers

# Two voices as unit vectors: "a" along the first axis, "b" along the second.
A, B = np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])


def unit(*values):
    vector = np.array(values, dtype=float)
    return vector / np.linalg.norm(vector)


def segment(id, speaker, verified=False, start=0.0, end=2.0):
    return {"id": id, "start": start, "end": end, "speaker": speaker, "text": "", "verified": verified}


def test_unverified_segments_take_the_closest_verified_speaker():
    segments = [
        segment("ref-a", "alice", verified=True),
        segment("ref-b", "bob", verified=True),
        segment("x", "bob"),
        segment("y", "speaker_7"),
    ]
    vectors = {"ref-a": A, "ref-b": B, "x": unit(0.9, 0.1, 0), "y": unit(0.2, 0.9, 0)}
    result = speakers.assign(segments, vectors)
    assert result == {"labels": {"x": "alice", "y": "bob"}, "uncertain": 0, "too_short": 0}


def test_verified_segments_are_never_relabelled():
    segments = [segment("ref-a", "alice", verified=True), segment("ref-b", "bob", verified=True)]
    # ref-b sounds exactly like alice, but the user has said it is bob.
    assert speakers.assign(segments, {"ref-a": A, "ref-b": A})["labels"] == {}


def test_a_segment_unlike_every_verified_speaker_is_left_alone():
    segments = [segment("ref-a", "alice", verified=True), segment("stranger", "speaker_3")]
    result = speakers.assign(segments, {"ref-a": A, "stranger": unit(0.2, 0, 1)})
    assert result == {"labels": {}, "uncertain": 1, "too_short": 0}


def test_segments_without_an_embedding_are_counted_as_too_short():
    segments = [segment("ref-a", "alice", verified=True), segment("blip", "bob")]
    assert speakers.assign(segments, {"ref-a": A}) == {"labels": {}, "uncertain": 0, "too_short": 1}


def test_longer_verified_segments_weigh_more_in_a_speaker_profile():
    segments = [
        segment("long", "alice", verified=True, end=9.0),
        segment("short", "alice", verified=True, end=1.0),
        segment("x", "?"),
    ]
    vectors = {"long": A, "short": np.array([0.0, 0.0, 1.0]), "x": A}
    # Weighted by length the profile is nearly the long segment (similarity 0.99
    # to x); an unweighted average would sit halfway (0.71) and miss the bar.
    assert speakers.assign(segments, vectors, threshold=0.9)["labels"] == {"x": "alice"}


def test_relabelling_needs_a_verified_segment():
    with pytest.raises(speakers.SpeakerError, match="Verify at least one"):
        speakers.relabel([segment("x", "bob")], wav=None, cache=None)


def test_verified_segments_all_too_short_is_an_error():
    with pytest.raises(speakers.SpeakerError, match="too short"):
        speakers.assign([segment("ref-a", "alice", verified=True), segment("x", "bob")], {"x": A})
