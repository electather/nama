#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_image="mcr.microsoft.com/dotnet/sdk:9.0.203@sha256:fe3c1ed472bb0964c100f06aa9b1759f5ed84e0dfe6904d60f6a82159d3c7ae4"
extension_directory="${repository_root}/extensions/jellyfin"
artifact="${extension_directory}/artifacts/Nama.Jellyfin.Extension-1.0.0-jellyfin-10.11.11.zip"
fixture_dll="${extension_directory}/artifacts/fixture/Nama.Jellyfin.Extension.dll"

run_dotnet() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp/nama-dotnet-home \
    --volume "${repository_root}:/src" \
    --workdir /src/extensions/jellyfin \
    "${sdk_image}" \
    "$@"
}

run_dotnet sh -c \
  "dotnet restore Nama.Jellyfin.Extension.csproj --locked-mode &&
   dotnet format Nama.Jellyfin.Extension.csproj --no-restore --verify-no-changes &&
   dotnet build Nama.Jellyfin.Extension.csproj \
     --configuration Release \
     --no-restore \
     --property:ContinuousIntegrationBuild=true"

test -f "${artifact}"
test -s "${artifact}"
test -f "${fixture_dll}"
test -s "${fixture_dll}"
