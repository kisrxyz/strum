"""The app's settings and the user's own amps as files (userdata.py), and the built page (installed app)."""

import dataclasses
import json

from conftest import fake_analyzer, fake_separator, fake_transcriber, local_client

from kv_service.app import create_app
from kv_service.userdata import UserData

AMP_ID = "user:0f8fad5b-d9cb-469f-a165-70867728950e"
CAB_ID = "user:7c9e6679-7425-40de-944b-e07fc1f90ae7"


def make_app(settings):
    return create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())


def test_settings_round_trip(settings):
    with local_client(make_app(settings)) as client:
        missing = client.get("/api/settings")
        assert missing.status_code == 404
        assert missing.json()["detail"]["code"] == "settings.none"
        stored = {"state": {"language": "ru", "masterDb": -8}, "version": 4}
        assert client.put("/api/settings", json=stored).status_code == 204
        assert client.get("/api/settings").json() == stored
        # Beside the songs in the author's copy: library/settings.json.
        assert json.loads((settings.library_dir / "settings.json").read_text(encoding="utf-8")) == stored


def test_settings_refuse_junk(settings):
    with local_client(make_app(settings)) as client:
        assert client.put("/api/settings", content=b"[1, 2]").json()["detail"]["code"] == "settings.bad"
        assert client.put("/api/settings", content=b"{nope").status_code == 422
        too_big = client.put("/api/settings", content=b'{"x": "' + b"a" * 2_000_001 + b'"}')
        assert too_big.status_code == 413


def test_settings_live_in_the_user_folder(settings, tmp_path):
    installed = dataclasses.replace(settings, user_dir=tmp_path / "Documents" / "Strum")
    with local_client(make_app(installed)) as client:
        assert client.put("/api/settings", json={"state": {}, "version": 4}).status_code == 204
    assert (tmp_path / "Documents" / "Strum" / "settings.json").is_file()
    assert not (settings.library_dir / "settings.json").exists()


def test_assets_round_trip(settings):
    nam = json.dumps({"architecture": "WaveNet", "weights": [0.1]}).encode()
    wav = b"RIFF\x00\x00\x00\x00WAVEfmt "
    with local_client(make_app(settings)) as client:
        assert client.get("/api/assets").json() == []
        put = client.put(f"/api/assets/{AMP_ID}", params={"name": "My Plexi.nam", "kind": "model", "addedAt": 5}, content=nam)
        assert put.status_code == 204
        client.put(f"/api/assets/{CAB_ID}", params={"name": "V30 / 4x12.wav", "kind": "ir", "addedAt": 7}, content=wav)
        listed = client.get("/api/assets").json()
        assert listed == [
            {"id": AMP_ID, "name": "My Plexi.nam", "kind": "model", "addedAt": 5},
            {"id": CAB_ID, "name": "V30 / 4x12.wav", "kind": "ir", "addedAt": 7},
        ]
        assert client.get(f"/api/assets/{AMP_ID}").content == nam
        assert client.get(f"/api/assets/{CAB_ID}").content == wav
        # Files a person can find: named after what they dropped, unsafe characters replaced.
        amps = settings.library_dir / "Amps"
        assert sorted(p.name for p in amps.iterdir()) == ["My Plexi.nam", "V30 _ 4x12.wav", "index.json"]
        assert client.delete(f"/api/assets/{AMP_ID}").status_code == 204
        assert client.get(f"/api/assets/{AMP_ID}").json()["detail"]["code"] == "asset.none"
        assert not (amps / "My Plexi.nam").exists()
        assert [a["id"] for a in client.get("/api/assets").json()] == [CAB_ID]


def test_assets_refuse_bad_ids_and_empty_files(settings):
    with local_client(make_app(settings)) as client:
        bad_id = client.put("/api/assets/user:..%2F..%2Fx", params={"name": "x.nam", "kind": "model"}, content=b"{}")
        assert bad_id.status_code in (404, 422)
        empty = client.put(f"/api/assets/{AMP_ID}", params={"name": "x.nam", "kind": "model"}, content=b"")
        assert empty.status_code == 413
        wrong_kind = client.put(f"/api/assets/{AMP_ID}", params={"name": "x.nam", "kind": "song"}, content=b"{}")
        assert wrong_kind.status_code == 422


def test_same_names_get_a_number(tmp_path):
    data = UserData(tmp_path)
    data.put_asset(AMP_ID, "Amp.nam", "model", 1, b"{}")
    data.put_asset(CAB_ID, "amp.nam", "model", 2, b"{}")
    assert sorted(p.name for p in (tmp_path / "Amps").glob("*.nam")) == ["Amp.nam", "amp (2).nam"]
    # Sending the same id again replaces its file and keeps one entry.
    data.put_asset(AMP_ID, "Amp.nam", "model", 1, b'{"v": 2}')
    assert (tmp_path / "Amps" / "Amp.nam").read_bytes() == b'{"v": 2}'
    assert len(data.list_assets()) == 2


def test_runtime_in_the_authors_copy(settings):
    with local_client(make_app(settings)) as client:
        assert client.get("/api/runtime").json() == {"shell": False, "guitarPort": None, "instance": ""}


def test_installed_app_serves_the_page(settings, tmp_path):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>Strum</title>", encoding="utf-8")
    (web / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (web / "nam").mkdir()
    (web / "nam" / "nam-engine.wasm").write_bytes(b"\x00asm")
    installed = dataclasses.replace(settings, web_dir=web, shell=True, guitar_port=50123, instance="w0rd")
    with local_client(make_app(installed)) as client:
        page = client.get("/")
        assert page.status_code == 200 and "Strum" in page.text
        script = client.get("/assets/index-abc123.js")
        assert script.headers["content-type"].startswith("text/javascript")
        assert "immutable" in script.headers["cache-control"]
        assert client.get("/nam/nam-engine.wasm").headers["content-type"] == "application/wasm"
        # A missing file gets the page, as Vite does; the API keeps its own 404s.
        assert "Strum" in client.get("/tones/models/none.nam").text
        assert client.get("/api/nothing").status_code == 404
        assert client.get("/api/runtime").json() == {"shell": True, "guitarPort": 50123, "instance": "w0rd"}
        # Nothing outside the page's folder.
        assert "Strum" in client.get("/..%2F..%2Fsecret.txt").text


def test_installed_app_takes_only_its_own_page(settings, tmp_path):
    """Another local program's page (another port) may not drive the installed app's service."""
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html>", encoding="utf-8")
    installed = dataclasses.replace(settings, web_dir=web, shell=True, port=50100)
    with local_client(make_app(installed)) as client:
        own = client.put("/api/settings", json={"state": {}}, headers={"origin": "http://127.0.0.1:50100"})
        assert own.status_code == 204
        other = client.put("/api/settings", json={"state": {}}, headers={"origin": "http://localhost:3000"})
        assert other.status_code == 403
        assert other.json()["detail"]["code"] == "origin.forbidden"
    # The author's copy: the page comes through Vite on its own port.
    with local_client(make_app(settings)) as client:
        assert client.put("/api/settings", json={"state": {}}, headers={"origin": "http://localhost:5173"}).status_code == 204


def test_an_edited_index_never_reaches_outside_amps(tmp_path):
    data = UserData(tmp_path / "Strum")
    data.put_asset(AMP_ID, "Amp.nam", "model", 1, b"{}")
    secret = tmp_path / "secret.txt"
    secret.write_text("private", encoding="utf-8")
    index_path = tmp_path / "Strum" / "Amps" / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index[AMP_ID]["file"] = "../../secret.txt"
    index_path.write_text(json.dumps(index), encoding="utf-8")
    import pytest

    from kv_service.userdata import AssetNotFound

    with pytest.raises(AssetNotFound):
        data.asset_path(AMP_ID)
