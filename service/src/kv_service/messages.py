"""Messages for people. Python holds no words: it sends a code and its values, `{code, params}`, and
the app turns them into words in the user's language (the `service` namespace of src/i18n).

Codes are `area.what` in camelCase (`song.notFound`, `tab.tooLong`). Values are plain strings and
numbers: a limit goes as seconds, the app writes "12 min" or «12 минут». The guitar engine
(kv_guitar) uses the same module.
"""

from __future__ import annotations


def message(code: str, **params: str | int | float) -> dict:
    """{"code": code, "params": params}: what an HTTP `detail`, a job's `error` or the engine sends."""
    return {"code": code, "params": params}


class UserError(Exception):
    """A failure to tell the user: a code and its values. `str(error)` is the code, for the logs."""

    def __init__(self, code: str, **params: str | int | float) -> None:
        super().__init__(code)
        self.code = code
        self.params = params

    @property
    def message(self) -> dict:
        return message(self.code, **self.params)

    def __str__(self) -> str:
        return self.code


def reason_of(error: BaseException) -> str:
    """An unexpected error's own text on one line (or its type's name): the `reason` value."""
    return " ".join(str(error).split()) or type(error).__name__


def failure(code: str, error: BaseException) -> dict:
    """The message for a failure: a UserError's own, else `code` with the error as its `reason`."""
    if isinstance(error, UserError):
        return error.message
    return message(code, reason=reason_of(error))
