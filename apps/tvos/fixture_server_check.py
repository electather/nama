#!/usr/bin/env python3

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True

from fixture_server import FixtureServers


DUMMY_HEADERS = {
    "Authorization": "Bearer nama-player-lab-dummy-authorization",
    "X-Emby-Token": "nama-player-lab-dummy-jellyfin",
}


class StripCrossOriginCredentials(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if redirected and _origin(request.full_url) != _origin(new_url):
            sensitive_names = {name.lower() for name in DUMMY_HEADERS}
            for name, _ in redirected.header_items():
                if name.lower() in sensitive_names:
                    redirected.remove_header(name)
        return redirected


class ObserveRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def _origin(url):
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port


def _request(url, *, method="GET", headers=None, opener=None):
    request = urllib.request.Request(url, method=method, headers=headers or {})
    return opener.open(request, timeout=2) if opener else urllib.request.urlopen(request, timeout=2)


def _expect_416(url, range_value, total=10):
    try:
        _request(url, headers={"Range": range_value})
    except urllib.error.HTTPError as error:
        assert error.code == 416
        assert error.headers["Content-Range"] == f"bytes */{total}"
        assert error.read() == b""
    else:
        raise AssertionError(f"range {range_value!r} was accepted")


def _expect_redirect(url, expected_location):
    opener = urllib.request.build_opener(ObserveRedirect())
    try:
        _request(url, opener=opener)
    except urllib.error.HTTPError as error:
        assert error.code == 307
        assert error.headers["Location"] == expected_location
        assert error.headers["Content-Length"] == "0"
        assert error.read() == b""
    else:
        raise AssertionError(f"redirect {url!r} was followed")


def _credential_status(origin):
    with _request(f"{origin}/credential-check") as response:
        body = response.read()
    result = json.loads(body)
    assert set(result) == {"dummy_credentials_received"}
    assert not any(value.encode() in body for value in DUMMY_HEADERS.values())
    return result["dummy_credentials_received"]


def main():
    with tempfile.TemporaryDirectory() as temporary_directory:
        temporary = Path(temporary_directory)
        fixtures = temporary / "fixtures"
        fixtures.mkdir()
        (fixtures / "media").mkdir()
        (fixtures / "media" / "sample.bin").write_bytes(b"0123456789")
        (fixtures / "media" / "empty.bin").write_bytes(b"")
        (fixtures / "media" / "race.bin").write_bytes(b"inside")
        outside = temporary / "outside.bin"
        outside.write_bytes(b"outside")
        (fixtures / "outside-link.bin").symlink_to(outside)
        outside_directory = temporary / "outside"
        outside_directory.mkdir()
        (outside_directory / "secret.bin").write_bytes(b"secret")
        (fixtures / "swapped-component").symlink_to(outside_directory, target_is_directory=True)

        resolved_fixtures = fixtures.resolve()
        original_open = os.open
        root_open_calls = 0

        def swap_root_before_open(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal root_open_calls
            if (Path(path) == resolved_fixtures and dir_fd is None) or (
                path == resolved_fixtures.name and dir_fd is not None
            ):
                root_open_calls += 1
                fixtures.rename(temporary / "original-fixtures")
                fixtures.symlink_to(outside_directory, target_is_directory=True)
            return original_open(path, flags, mode, dir_fd=dir_fd)

        os.open = swap_root_before_open
        try:
            try:
                FixtureServers(fixtures, "127.0.0.1", 0, 0)
            except OSError:
                pass
            else:
                raise AssertionError("a fixture root swapped to an outside symlink was opened")
        finally:
            os.open = original_open
        assert root_open_calls == 1
        fixtures.unlink()
        (temporary / "original-fixtures").rename(fixtures)

        with FixtureServers(fixtures, "127.0.0.1", 0, 0) as servers:
            media_url = f"{servers.primary_origin}/media/sample.bin"

            with _request(media_url) as response:
                assert response.status == 200
                assert response.headers["Content-Length"] == "10"
                assert response.read() == b"0123456789"

            with _request(media_url, method="HEAD") as response:
                assert response.status == 200
                assert response.headers["Content-Length"] == "10"
                assert response.read() == b""

            with _request(media_url, headers={"Range": "bytes=2-5"}) as response:
                assert response.status == 206
                assert response.headers["Content-Range"] == "bytes 2-5/10"
                assert response.headers["Content-Length"] == "4"
                assert response.read() == b"2345"

            with _request(media_url, headers={"Range": "bytes=-3"}) as response:
                assert response.status == 206
                assert response.headers["Content-Range"] == "bytes 7-9/10"
                assert response.read() == b"789"

            with _request(media_url, headers={"Range": "bytes=6-"}) as response:
                assert response.status == 206
                assert response.headers["Content-Range"] == "bytes 6-9/10"
                assert response.headers["Content-Length"] == "4"
                assert response.read() == b"6789"

            with _request(media_url, headers={"Range": "bytes=0-3"}) as response:
                assert response.status == 206
                assert response.headers["Content-Range"] == "bytes 0-3/10"
                assert response.headers["Content-Length"] == "4"
                assert response.read() == b"0123"

            with _request(media_url, method="HEAD", headers={"Range": "bytes=1-3"}) as response:
                assert response.status == 206
                assert response.headers["Content-Length"] == "3"
                assert response.read() == b""

            for bad_range in ("bytes=8-3", "bytes=20-", "bytes=0-1,4-5", "bytes=abc"):
                _expect_416(media_url, bad_range)

            empty_url = f"{servers.primary_origin}/media/empty.bin"
            with _request(empty_url) as response:
                assert response.status == 200
                assert response.headers["Content-Length"] == "0"
                assert response.read() == b""
            _expect_416(empty_url, "bytes=0-0", total=0)

            unsafe_paths = (
                "/%2e%2e/outside.bin",
                "/%252e%252e/outside.bin",
                "/media/%2e%2e/%2e%2e/outside.bin",
                "/%2e%2e%2foutside.bin",
                "/media%5c..%5coutside.bin",
                "/outside-link.bin",
                "/swapped-component/secret.bin",
            )
            for unsafe_path in unsafe_paths:
                try:
                    _request(f"{servers.primary_origin}{unsafe_path}")
                except urllib.error.HTTPError as error:
                    assert error.code == 404
                    assert error.read() == b""
                else:
                    raise AssertionError(f"unsafe path {unsafe_path!r} was served")

            race_path = (fixtures / "media" / "race.bin").resolve()
            original_open = os.open
            open_calls = 0

            def swap_between_validation_and_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal open_calls
                if path == "race.bin" and dir_fd is not None:
                    open_calls += 1
                    race_path.unlink()
                    race_path.symlink_to(outside)
                return original_open(path, flags, mode, dir_fd=dir_fd)

            os.open = swap_between_validation_and_open
            try:
                try:
                    _request(f"{servers.primary_origin}/media/race.bin")
                except urllib.error.HTTPError as error:
                    assert error.code == 404
                    assert error.read() == b""
                else:
                    raise AssertionError("a component swapped to a symlink was served")
            finally:
                os.open = original_open
            assert open_calls == 1

            with _request(media_url, headers=DUMMY_HEADERS) as response:
                assert response.read() == b"0123456789"
            assert _credential_status(servers.primary_origin) is True
            assert _credential_status(servers.primary_origin) is False

            same_url = f"{servers.primary_origin}/redirect/same/media/sample.bin"
            _expect_redirect(same_url, "/media/sample.bin")
            with _request(same_url, headers=DUMMY_HEADERS) as response:
                assert response.url == media_url
                assert response.read() == b"0123456789"
            assert _credential_status(servers.primary_origin) is True

            with _request(f"{servers.secondary_origin}/media/sample.bin", headers=DUMMY_HEADERS) as response:
                assert response.read() == b"0123456789"
            assert _credential_status(servers.secondary_origin) is True
            assert _credential_status(servers.secondary_origin) is False

            cross_url = f"{servers.primary_origin}/redirect/cross/media/sample.bin"
            _expect_redirect(cross_url, f"{servers.secondary_origin}/media/sample.bin")
            opener = urllib.request.build_opener(StripCrossOriginCredentials())
            with _request(cross_url, headers=DUMMY_HEADERS, opener=opener) as response:
                assert response.url == f"{servers.secondary_origin}/media/sample.bin"
                assert response.read() == b"0123456789"
            assert _credential_status(servers.primary_origin) is True
            assert _credential_status(servers.secondary_origin) is False

    print("fixture server self-check: OK")


if __name__ == "__main__":
    main()
