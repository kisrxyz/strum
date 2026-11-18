"""The job queue: one worker thread, one model on the GPU at a time.

Three kinds of jobs share it: separations, keyed (song id, model id); analyses, keyed
(song id, ANALYSIS); transcriptions (the words of the vocal stem), keyed (song id, TRANSCRIBE).
An analysis follows every separation that brings new stems, a transcription follows the analysis
of a song with stems; both go to the front of the queue, so a song is ready to play along with as
soon as possible. Only one of the three models sits in video memory: the others are unloaded
before a job runs.

The state that must survive a restart (queued / running / ready / error) lives in song.json, a
failure as a message (`{code, params}`, messages.py); progress is only kept in memory. A job
whose song was deleted, or whose stems were dropped, is cancelled at its next progress tick and
its results are thrown away.

Locks: the API threads take the queue lock first and the library lock inside it; the worker
never takes the queue lock while it holds the library lock.
"""

from __future__ import annotations

import threading
from collections import deque
from collections.abc import Callable

from .analysis import AnalysisError, Analyzer, mono
from .audio import read_audio
from .library import ANALYSIS, TRANSCRIBE, Library, SongNotFound, analysis_needed, has_ready_stems, transcript_needed
from .lyrics import TranscribeError, Transcriber
from .messages import UserError, failure, message
from .separation import Cancelled, SeparationError, Separator

Key = tuple[str, str]  # (song id, model id, ANALYSIS or TRANSCRIBE)
# The stems the analysis uses: vocals (sections), guitar (sections, tone, tuning), keys and other (tuning).
ANALYSIS_STEMS = ("vocals", "guitar", "piano", "other")


class NoStems(UserError, ValueError):
    """The words are heard in the vocal stem: a song without stems has none."""


class JobQueue:
    def __init__(
        self,
        library: Library,
        separator: Separator,
        analyzer: Analyzer | None = None,
        transcriber: Transcriber | None = None,
        ready: Callable[[], bool] | None = None,
    ):
        """Without an analyzer the queue only separates, as in stage 1; without a transcriber it
        does not hear the words, as in stage 2. While `ready()` is false (the installed app before
        its neural networks arrive) the jobs wait in the queue, and in song.json as queued, so they
        run after the restart that follows the download."""
        self.ready = ready or (lambda: True)
        self.library = library
        self.separator = separator
        self.analyzer = analyzer
        self.transcriber = transcriber
        self._queue: deque[Key] = deque()
        self._cv = threading.Condition()
        self._running: Key | None = None
        self._progress: dict[Key, float] = {}
        self._cancelled: set[Key] = set()
        self._idle = threading.Event()
        self._idle.set()
        self._stopping = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        with self._cv:
            for key in self.library.recover(analysis=self.analyzer is not None, transcription=self.transcriber is not None):
                self._queue.append(key)
                self._idle.clear()
        self._thread = threading.Thread(target=self._work, name="separation", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        with self._cv:
            self._stopping = True
            if self._running:
                self._cancelled.add(self._running)
            self._cv.notify_all()
        if self._thread:
            self._thread.join(timeout)

    def submit(self, song_id: str, model: str) -> dict:
        """Queues a separation (again, if it was done or failed). Returns the song."""
        key = (song_id, model)
        with self._cv:
            if key == self._running or key in self._queue:
                return self.library.get(song_id)
            song = self.library.set_stems(song_id, model, status="queued", error=None, note=None)
            self._cancelled.discard(key)
            self._queue.append(key)
            self._idle.clear()
            self._cv.notify()
            return song

    def submit_analysis(self, song_id: str) -> dict:
        """Queues an analysis (again: the user's chord edits stay), ahead of the separations.
        Returns the song; an analysis already queued or running is left as it is."""
        with self._cv:
            return self._queue_analysis(song_id) or self.library.get(song_id)

    def _queue_analysis(self, song_id: str) -> dict | None:
        """Under self._cv. The song with its analysis queued, or None when that was not needed."""
        key = (song_id, ANALYSIS)
        if self.analyzer is None or key == self._running or key in self._queue:
            return None
        try:
            song = self.library.set_analysis(song_id, status="queued", error=None)
        except SongNotFound:
            return None
        self._cancelled.discard(key)
        self._queue.appendleft(key)
        self._idle.clear()
        self._cv.notify()
        return song

    def submit_transcription(self, song_id: str) -> dict:
        """Queues hearing the words (again: the user's lyrics stay), ahead of the separations.
        Raises NoStems for a song without ready stems."""
        with self._cv:
            song = self.library.get(song_id)
            if not has_ready_stems(song):
                raise NoStems("transcript.needsStems")
            return self._queue_transcription(song_id) or self.library.get(song_id)

    def _queue_transcription(self, song_id: str) -> dict | None:
        """Under self._cv. The song with its transcription queued, or None when that was not needed."""
        key = (song_id, TRANSCRIBE)
        if self.transcriber is None or key == self._running or key in self._queue:
            return None
        try:
            song = self.library.set_transcript(song_id, status="queued", error=None)
        except SongNotFound:
            return None
        self._cancelled.discard(key)
        self._queue.appendleft(key)
        self._idle.clear()
        self._cv.notify()
        return song

    def _follow_transcript(self, song: dict) -> None:
        """After an analysis (or a separation that needs none): the words, when they are due."""
        if self.transcriber is None or not transcript_needed(song):
            return
        with self._cv:
            self._queue_transcription(song["id"])

    def _follow_up(self, song: dict, separated: bool) -> None:
        """After a separation: an analysis when the new stems call for one, or one from the mix
        when the separation failed, no stems are ready and no other separation is coming.
        Without an analysis to wait for, the words follow at once."""
        if self.analyzer is None or not analysis_needed(song):
            self._follow_transcript(song)
            return
        with self._cv:
            if not separated and (
                has_ready_stems(song) or any(k[0] == song["id"] and k[1] != ANALYSIS for k in self._queue)
            ):
                return
            self._queue_analysis(song["id"])

    def cancel(self, song_id: str, model: str | None = None) -> None:
        """Cancels the song's jobs: all of them, or only the separation with `model`."""

        def matches(key: Key) -> bool:
            return key[0] == song_id and (model is None or key[1] == model)

        with self._cv:
            for key in [k for k in self._queue if matches(k)]:
                self._queue.remove(key)
            if self._running and matches(self._running):
                self._cancelled.add(self._running)

    def progress(self, song_id: str, job: str) -> float | None:
        """0..1 of the running job: `job` is a model id or ANALYSIS."""
        return self._progress.get((song_id, job))

    def wait_idle(self, timeout: float) -> bool:
        return self._idle.wait(timeout)

    def _work(self) -> None:
        while True:
            with self._cv:
                while (not self._queue or not self.ready()) and not self._stopping:
                    self._unload_all()  # free the GPU while nothing is waiting
                    self._idle.set()
                    self._cv.wait(timeout=5.0 if self._queue else None)
                if self._stopping:
                    self._idle.set()
                    return
                key = self._queue.popleft()
                self._running = key
                self._progress[key] = 0.0
            try:
                if key[1] == ANALYSIS:
                    self._analyse(key)
                elif key[1] == TRANSCRIBE:
                    self._transcribe(key)
                else:
                    self._run(key)
            except Exception as error:  # noqa: BLE001 - a broken song must not stop the queue
                if key[1] == ANALYSIS:
                    self._fail(key, failure("analysis.failed", error))
                elif key[1] == TRANSCRIBE:
                    self._fail(key, failure("words.failed", error))
                else:
                    self._fail(key, failure("separation.failed", error))
            finally:
                with self._cv:
                    self._running = None
                    self._progress.pop(key, None)
                    self._cancelled.discard(key)

    def _unload_all(self) -> None:
        self.separator.unload()
        self._unload_others()

    def _unload_others(self, keep: object = None) -> None:
        """Unloads the analyzer and the transcriber (but `keep`): one model in video memory at a time."""
        for model in (self.analyzer, self.transcriber):
            if model is not None and model is not keep:
                model.unload()

    def _progress_of(self, key: Key):
        def progress(fraction: float) -> None:
            if key in self._cancelled:
                raise Cancelled()
            self._progress[key] = min(1.0, max(0.0, fraction))

        return progress

    def _run(self, key: Key) -> None:
        song_id, model = key
        try:
            with self.library.lock:
                # cancel() runs before the API drops the stems, so this check under the library
                # lock never brings back an entry that was just removed.
                if key in self._cancelled:
                    return
                self.library.set_stems(song_id, model, status="running", error=None, note=None)
                mix, sr = read_audio(self.library.mix_path(song_id))
        except SongNotFound:
            return
        self._unload_others()  # one model in video memory at a time

        try:
            result = self.separator.run(model, mix, sr, self._progress_of(key))
        except Cancelled:
            return
        except SeparationError as error:
            self._fail(key, error.message)
            return
        except Exception as error:  # noqa: BLE001 - shown to the user, the queue goes on
            self._fail(key, failure("separation.failed", error))
            return
        meta = {
            "device": result.device,
            "seconds": result.seconds,
            "loadSeconds": result.load_seconds,
            "peakVramMb": result.peak_vram_mb,
            "note": result.note,
        }
        with self.library.lock:
            if key in self._cancelled:
                return
            try:
                song = self.library.write_stems(song_id, model, result.stems, meta)
            except SongNotFound:
                return
        self._follow_up(song, separated=True)

    def _analyse(self, key: Key) -> None:
        song_id = key[0]
        assert self.analyzer is not None
        try:
            with self.library.lock:
                if key in self._cancelled:
                    return
                # Counted before the work starts: if the process dies in the middle, the next
                # start sees an analysis that was cut off (library.MAX_ANALYSIS_ATTEMPTS).
                attempts = int((self.library.get(song_id).get("analysis") or {}).get("attempts") or 0) + 1
                song = self.library.set_analysis(song_id, status="running", error=None, attempts=attempts)
                mix, sr = read_audio(self.library.mix_path(song_id))
                stems = None
                source = "mix"
                if has_ready_stems(song):
                    source = song["activeModel"]
                    # mono right away: six stereo stems of a long song would take a lot of memory
                    stems = {
                        stem: mono(read_audio(self.library.stem_path(song_id, source, stem))[0])
                        for stem in ANALYSIS_STEMS
                    }
        except SongNotFound:
            return
        self.separator.unload()  # one model in video memory at a time
        self._unload_others(keep=self.analyzer)

        try:
            result = self.analyzer.run(mix, stems, source, sr, self._progress_of(key))
        except Cancelled:
            return
        except AnalysisError as error:
            self._fail(key, error.message)
            return
        except Exception as error:  # noqa: BLE001 - shown to the user, the queue goes on
            self._fail(key, failure("analysis.failed", error))
            return
        with self.library.lock:
            if key in self._cancelled:
                return
            try:
                song = self.library.write_analysis(song_id, result.data, {"device": result.device, "seconds": result.seconds})
            except SongNotFound:
                return
        self._follow_transcript(song)

    def _transcribe(self, key: Key) -> None:
        song_id = key[0]
        assert self.transcriber is not None
        try:
            with self.library.lock:
                if key in self._cancelled:
                    return
                song = self.library.get(song_id)
                if not has_ready_stems(song):  # the stems were dropped since it was queued
                    self.library.set_transcript(
                        song_id, status="error", error=message("transcript.needsStems"), attempts=0
                    )
                    return
                # Counted before the work starts, as for the analysis: a native crash in the
                # middle is seen at the next start (library.MAX_ANALYSIS_ATTEMPTS).
                attempts = int((song.get("transcript") or {}).get("attempts") or 0) + 1
                song = self.library.set_transcript(song_id, status="running", error=None, attempts=attempts)
                source = song["activeModel"]
                vocals, sr = read_audio(self.library.stem_path(song_id, source, "vocals"))
        except SongNotFound:
            return
        self.separator.unload()  # one model in video memory at a time
        self._unload_others(keep=self.transcriber)

        try:
            result = self.transcriber.run(vocals, sr, source, self._progress_of(key))
        except Cancelled:
            return
        except TranscribeError as error:
            self._fail(key, error.message)
            return
        except Exception as error:  # noqa: BLE001 - shown to the user, the queue goes on
            self._fail(key, failure("words.failed", error))
            return
        with self.library.lock:
            if key in self._cancelled:
                return
            try:
                self.library.write_words(song_id, result.data, {"device": result.device, "seconds": result.seconds})
            except SongNotFound:
                return

    def _fail(self, key: Key, error: dict) -> None:
        """Marks the job failed in song.json; `error` is a message (messages.py)."""
        song_id, job = key
        with self.library.lock:
            if key in self._cancelled:
                return
            try:
                if job == TRANSCRIBE:
                    self.library.set_transcript(song_id, status="error", error=error, attempts=0)
                    return
                if job == ANALYSIS:
                    # A failure that was caught is not a crash: the next start may try again.
                    song = self.library.set_analysis(song_id, status="error", error=error, attempts=0)
                else:
                    song = self.library.set_stems(song_id, job, status="error", error=error)
            except SongNotFound:
                return
        if job == ANALYSIS:
            self._follow_transcript(song)  # the words do not need the bars
        else:
            self._follow_up(song, separated=False)
