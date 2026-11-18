"""Only the app itself may change things: other web sites open in the same browser must not."""

import pytest

from conftest import local_client, fake_separator, sine, wav_bytes
from kv_service.app import create_app


@pytest.fixture
def client(settings):
    with local_client(create_app(settings, separator=fake_separator())) as c:
        yield c


def upload(client, **headers):
    files = {"original": ("a.wav", b"original"), "mix": ("mix.wav", wav_bytes(sine(1.0)), "audio/wav")}
    return client.post("/api/songs", files=files, data={"fileName": "a.wav"}, headers=headers)


def test_a_foreign_site_cannot_add_songs(client):
    # A form post from another site is a "simple request": the browser sends it without asking.
    response = upload(client, Origin="https://evil.example")
    assert response.status_code == 403
    assert client.get("/api/songs").json() == []


def test_dns_rebinding_hosts_are_refused(client):
    assert client.get("/api/songs", headers={"Host": "evil.example:5174"}).status_code == 403


def test_the_app_and_local_tools_are_welcome(client):
    assert upload(client, Origin="http://localhost:5173").status_code == 201
    assert client.get("/api/songs", headers={"Host": "localhost:5173"}).status_code == 200
    assert client.get("/api/songs", headers={"Host": "127.0.0.1:5174"}).status_code == 200
    # compare.py and curl send no Origin at all
    assert client.get("/api/health").status_code == 200
