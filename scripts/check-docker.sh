#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repository_root}/compose.yaml"
development_compose_file="${repository_root}/compose.development.yaml"
packaging_compose_file="${repository_root}/apps/server/integration/tests/compose.packaging.yaml"
project="nama-package-${PPID}-$$"
native_home="${HOME}"
check_image="nama:check-${PPID}-$$"
work_directory="$(mktemp -d "${repository_root}/.nama-docker-check.XXXXXX")"
test -n "${work_directory}"
test -d "${work_directory}"
test ! -L "${work_directory}"
chmod 700 "${work_directory}"

export NAMA_CONFIG_PATH="${work_directory}/nama.toml"
export NAMA_POSTGRES_PASSWORD_FILE="${work_directory}/postgres-password"
unset NAMA_HOST_BIND NAMA_HOST_PORT NAMA_IMAGE NAMA_POSTGRES_HOST_PORT NAMA_OUTPUT NAMA_PROFILE NAMA_SERVER NAMA_TOKEN

canonical_compose=(docker compose --project-name "${project}" --file "${compose_file}")
development_compose=(docker compose --project-name "${project}" --file "${compose_file}" --file "${development_compose_file}")
runtime_compose=(docker compose --project-name "${project}" --file "${compose_file}" --file "${packaging_compose_file}")
cli_binary="${work_directory}/nama"
cli_home="${work_directory}/cli-home"
profile="docker-${PPID}-$$"

cleanup() {
  local body_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  if [ -n "${jellyfin_container_id:-}" ]; then
    docker unpause "${jellyfin_container_id}" >/dev/null 2>&1 || true
  fi
  if [ -n "${instance_test_process:-}" ] && kill -0 "${instance_test_process}" 2>/dev/null; then
    kill "${instance_test_process}" 2>/dev/null || true
    wait "${instance_test_process}" 2>/dev/null || true
  fi
  if [ "${body_status}" -ne 0 ]; then
    "${runtime_compose[@]}" logs --no-color nama 2>&1 |
      sed 's/NAMA_BOOTSTRAP_TOKEN=.*/NAMA_BOOTSTRAP_TOKEN=<redacted>/' >&2 || true
  fi
  if [ -x "${cli_binary}" ] && [ -d "${cli_home}" ]; then
    if ! HOME="${cli_home}" XDG_CONFIG_HOME="${cli_home}" APPDATA="${cli_home}" \
      "${cli_binary}" profile set "${profile}" --server http://127.0.0.1:1/ --output json \
      >/dev/null 2>&1; then
      cleanup_status=1
    fi
  fi
  if ! "${runtime_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1; then
    cleanup_status=1
  fi
  if docker image inspect "${check_image}" >/dev/null 2>&1; then
    if ! docker image rm "${check_image}" >/dev/null 2>&1; then
      cleanup_status=1
    fi
  fi
  if ! rm -rf -- "${work_directory:?}"; then
    cleanup_status=1
  fi
  if [ "${body_status}" -ne 0 ]; then
    exit "${body_status}"
  fi
  if [ "${cleanup_status}" -ne 0 ]; then
    printf '%s\n' "Docker packaging cleanup failed" >&2
    exit 1
  fi
  exit 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_json() {
  local path="$1"
  local expression="$2"
  shift 2
  node --input-type=module --eval '
    import { readFileSync } from "node:fs";
    const value = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const assertionArguments = process.argv.slice(3);
    const assertion = Function("value", "assertionArguments", `return (${process.argv[2]});`);
    if (!assertion(value, assertionArguments)) process.exit(1);
  ' "${path}" "${expression}" "$@"
}

run_cli() {
  local output_path="$1"
  shift
  HOME="${cli_home}" XDG_CONFIG_HOME="${cli_home}" APPDATA="${cli_home}" \
    "${cli_binary}" "$@" --output json >"${output_path}"
}

plugin_process_ids() {
  "${runtime_compose[@]}" exec --no-TTY nama node --input-type=module --eval '
    import { readdir, readFile } from "node:fs/promises";
    const targetSuffix = "/plugins/jellyfin/src/main.ts";
    const ids = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const arguments_ = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
        if (arguments_.some((argument) => argument.endsWith(targetSuffix))) ids.push(Number(entry));
      } catch {}
    }
    ids.sort((left, right) => left - right);
    process.stdout.write(ids.join("\n"));
  '
}

plugin_has_jellyfin_connection() {
  local plugin_pid="$1"
  "${runtime_compose[@]}" exec --no-TTY nama node --input-type=module --eval '
    import { readdir, readFile, readlink } from "node:fs/promises";
    const pluginPid = process.argv[1];
    const socketInodes = new Set();
    for (const entry of await readdir(`/proc/${pluginPid}/fd`)) {
      try {
        const target = await readlink(`/proc/${pluginPid}/fd/${entry}`);
        const match = /^socket:\[(\d+)\]$/u.exec(target);
        if (match?.[1] !== undefined) socketInodes.add(match[1]);
      } catch {}
    }
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const rows = (await readFile(table, "utf8")).trim().split("\n").slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/u);
        const remoteAddress = fields[2];
        const inode = fields[9];
        if (
          inode !== undefined &&
          remoteAddress?.toUpperCase().endsWith(":1FA0") === true &&
          socketInodes.has(inode)
        ) {
          process.exit(0);
        }
      }
    }
    process.exit(1);
  ' "${plugin_pid}"
}

for required_file in "${development_compose_file}" "${packaging_compose_file}" "${repository_root}/Dockerfile"; do
  test -f "${required_file}" || fail "required Docker packaging file is missing: ${required_file}"
done

node --input-type=module --eval '
  import { randomBytes } from "node:crypto";
  import { writeFileSync } from "node:fs";
  writeFileSync(process.argv[1], randomBytes(24).toString("base64url"), { mode: 0o600 });
' "${NAMA_POSTGRES_PASSWORD_FILE}"
database_password="$(cat "${NAMA_POSTGRES_PASSWORD_FILE}")"
master_key="base64:$(node --input-type=module --eval 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64"));')"
administrator_password="$(node --input-type=module --eval 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"));')"
cat >"${NAMA_CONFIG_PATH}" <<EOF
[server]
bind = "0.0.0.0:8080"
public_url = "http://localhost:8080/"

[database]
url = "postgresql://nama:${database_password}@postgres:5432/nama"
max_connections = 10

[security]
master_key = "${master_key}"

[logging]
level = "info"
EOF
chmod 600 "${NAMA_CONFIG_PATH}"

"${canonical_compose[@]}" config --quiet
"${development_compose[@]}" config --quiet
canonical_model="${work_directory}/canonical-compose.json"
development_model="${work_directory}/development-compose.json"
"${canonical_compose[@]}" config --format json >"${canonical_model}"
"${development_compose[@]}" config --format json >"${development_model}"
node --input-type=module - "${canonical_model}" "${development_model}" <<'NODE'
import { readFileSync } from "node:fs";

const canonical = JSON.parse(readFileSync(process.argv[2], "utf8"));
const development = JSON.parse(readFileSync(process.argv[3], "utf8"));
const serviceNames = Object.keys(canonical.services ?? {}).sort();
if (JSON.stringify(serviceNames) !== JSON.stringify(["nama", "postgres"])) process.exit(1);
const nama = canonical.services.nama;
const postgres = canonical.services.postgres;
const namaPort = nama.ports?.[0];
if (
  nama.image !== "nama:local" ||
  nama.read_only !== true ||
  nama.restart !== "unless-stopped" ||
  nama.user !== "10001:10001" ||
  namaPort?.host_ip !== "127.0.0.1" ||
  namaPort?.target !== 8080 ||
  nama.ports.length !== 1 ||
  !nama.cap_drop?.includes("ALL") ||
  !nama.security_opt?.includes("no-new-privileges:true") ||
  !nama.tmpfs?.some((entry) => entry.startsWith("/run/nama:")) ||
  nama.depends_on?.postgres?.condition !== "service_healthy" ||
  !nama.healthcheck?.test?.some((entry) => entry.includes("/health/ready")) ||
  !nama.volumes?.some((entry) =>
    entry.target === "/etc/nama/nama.toml" && entry.read_only === true && entry.type === "bind"
  )
) process.exit(1);
if (
  postgres.ports !== undefined ||
  postgres.restart !== "unless-stopped" ||
  postgres.environment?.POSTGRES_PASSWORD !== undefined ||
  postgres.environment?.POSTGRES_PASSWORD_FILE !== "/run/secrets/postgres_password" ||
  !postgres.healthcheck?.test?.some((entry) => entry.includes("--host 127.0.0.1")) ||
  !postgres.secrets?.some((entry) => entry.source === "postgres_password")
) process.exit(1);
const developmentPostgresPort = development.services?.postgres?.ports?.[0];
if (developmentPostgresPort?.host_ip !== "127.0.0.1" || developmentPostgresPort?.target !== 5432) {
  process.exit(1);
}
NODE

export NAMA_IMAGE="${check_image}"
"${canonical_compose[@]}" build nama
application_image_id="$(docker image inspect --format '{{.Id}}' "${check_image}")"
test -n "${application_image_id}"
docker tag "${application_image_id}" nama:local
export NAMA_IMAGE="${application_image_id}"
image_model="${work_directory}/image.json"
docker image inspect "${application_image_id}" >"${image_model}"
assert_json "${image_model}" 'value.length === 1 && value[0].Config.User === "10001:10001" && value[0].Config.WorkingDir === "/app" && JSON.stringify(value[0].Config.Entrypoint) === JSON.stringify(["node", "apps/server/src/main.ts"])'
docker run --rm --entrypoint node "${application_image_id}" --input-type=module --eval '
  import { access, readdir, readFile } from "node:fs/promises";
  import { join } from "node:path";

  for (const path of [
    "/app/apps/server/src/main.ts",
    "/app/apps/server/drizzle/meta/_journal.json",
    "/app/plugins/jellyfin/src/main.ts",
    "/app/apps/server/node_modules/@nama/api/src/nama/plugin/v1/plugin_pb.js",
    "/app/plugins/jellyfin/node_modules/@nama/api/src/nama/plugin/v1/plugin_pb.js",
    "/app/gen/ts/src/nama/plugin/v1/plugin_pb.js",
  ]) await access(path);
  for (const path of ["/app/apps/cli", "/app/apps/server/integration"]) {
    try { await access(path); process.exit(1); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const inspectSource = async (root) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "tests") process.exit(1);
        await inspectSource(path);
      } else if (entry.name.endsWith(".test.ts")) process.exit(1);
    }
  };
  await inspectSource("/app/apps/server");
  await inspectSource("/app/plugins/jellyfin");
  const forbiddenPackages = new Set(["@nama/server", "better-auth", "drizzle-orm", "pg"]);
  const inspectPackages = async (root) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".pnpm" || entry.name.startsWith("@")) {
        await inspectPackages(path);
        continue;
      }
      try {
        const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
        if (forbiddenPackages.has(manifest.name)) process.exit(1);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await inspectPackages(path);
    }
  };
  await inspectPackages("/app/plugins/jellyfin/node_modules");
'
docker run --rm --user 0:0 --volume "${work_directory}:/fixture" \
  --entrypoint chown "${application_image_id}" 0:10001 /fixture/nama.toml
docker run --rm --user 0:0 --volume "${work_directory}:/fixture" \
  --entrypoint chmod "${application_image_id}" 0640 /fixture/nama.toml

go build -o "${cli_binary}" ./apps/cli/cmd/nama
mkdir -m 700 "${cli_home}"
if [ "$(uname -s)" = "Darwin" ]; then
  mkdir -m 700 "${cli_home}/Library"
  ln -s "${native_home}/Library/Keychains" "${cli_home}/Library/Keychains"
fi
run_cli "${work_directory}/schema.json" schema
assert_json "${work_directory}/schema.json" 'value.data.commands.some((command) => command.path.join(" ") === "nama setup") && value.data.commands.some((command) => command.path.join(" ") === "nama auth login") && value.data.commands.some((command) => command.path.join(" ") === "nama provider type test") && value.data.commands.some((command) => command.path.join(" ") === "nama provider instance create") && value.data.commands.some((command) => command.path.join(" ") === "nama provider instance test")'
"${cli_binary}" --help >/dev/null
"${cli_binary}" help setup >/dev/null
"${cli_binary}" help auth login >/dev/null
"${cli_binary}" help provider type test >/dev/null
"${cli_binary}" help provider instance create >/dev/null
"${cli_binary}" help provider instance test >/dev/null

export NAMA_HOST_PORT=
"${runtime_compose[@]}" config --quiet
"${runtime_compose[@]}" up --detach --wait --wait-timeout 240
nama_address="$("${runtime_compose[@]}" port nama 8080)"
nama_port="${nama_address##*:}"
export NAMA_HOST_PORT="${nama_port}"
nama_origin="http://127.0.0.1:${nama_port}"
jellyfin_address="$("${runtime_compose[@]}" port jellyfin 8096)"
jellyfin_port="${jellyfin_address##*:}"
jellyfin_container_id="$("${runtime_compose[@]}" ps --quiet jellyfin)"

node --input-type=module --eval '
  const response = await fetch(new URL("health/ready", process.argv[1]));
  if (response.status !== 200 || (await response.text()) !== "") process.exit(1);
' "${nama_origin}"

container_id="$("${runtime_compose[@]}" ps --quiet nama)"
docker exec "${container_id}" node --input-type=module --eval '
  import { rm, writeFile } from "node:fs/promises";
  let applicationWriteBlocked = false;
  try {
    await writeFile("/app/write-probe", "blocked");
  } catch (error) {
    if (error?.code !== "EACCES" && error?.code !== "EROFS") throw error;
    applicationWriteBlocked = true;
  }
  if (!applicationWriteBlocked) throw new Error("application root is writable");
  await writeFile("/run/nama/write-probe", "allowed", { mode: 0o600 });
  await rm("/run/nama/write-probe");
'

bootstrap_token=""
for _ in $(seq 1 60); do
  bootstrap_token="$("${runtime_compose[@]}" logs --no-color nama 2>/dev/null | sed -n 's/^.*NAMA_BOOTSTRAP_TOKEN=//p' | tail -n 1)"
  if [ -n "${bootstrap_token}" ]; then
    break
  fi
  sleep 1
done
test -n "${bootstrap_token}" || fail "Nama bootstrap token was not emitted"

run_cli "${work_directory}/profiles-before.json" profile list
run_cli "${work_directory}/profile-set.json" profile set "${profile}" --server "${nama_origin}"
run_cli "${work_directory}/profiles-after.json" profile list
assert_json "${work_directory}/profiles-after.json" \
  'value.data.profiles.some((profile) => profile.name === assertionArguments[0] && profile.server === assertionArguments[1])' \
  "${profile}" "${nama_origin}"

printf '%s\n' "${administrator_password}" | \
  HOME="${cli_home}" XDG_CONFIG_HOME="${cli_home}" APPDATA="${cli_home}" NAMA_BOOTSTRAP_TOKEN="${bootstrap_token}" \
  "${cli_binary}" setup --profile "${profile}" --display-name "Nama Administrator" --email administrator@example.test --output json \
  >"${work_directory}/setup.json"
assert_json "${work_directory}/setup.json" 'value.data.initialized === true && value.data.signed_in === true'
run_cli "${work_directory}/status-after-setup.json" auth status --profile "${profile}"
assert_json "${work_directory}/status-after-setup.json" 'value.data.signed_in === true'

run_cli "${work_directory}/profile-clear.json" profile set "${profile}" --server http://127.0.0.1:1/
run_cli "${work_directory}/profile-restore.json" profile set "${profile}" --server "${nama_origin}"
printf '%s\n' "${administrator_password}" | \
  HOME="${cli_home}" XDG_CONFIG_HOME="${cli_home}" APPDATA="${cli_home}" \
  "${cli_binary}" auth login --profile "${profile}" --email administrator@example.test --output json \
  >"${work_directory}/login.json"
assert_json "${work_directory}/login.json" 'value.data.signed_in === true'
run_cli "${work_directory}/status-after-login.json" auth status --profile "${profile}"
assert_json "${work_directory}/status-after-login.json" 'value.data.signed_in === true'

run_cli "${work_directory}/provider-types.json" provider type list --profile "${profile}"
assert_json "${work_directory}/provider-types.json" 'value.data.provider_types.some((provider) => provider.id === "jellyfin")'
provider_configuration="${work_directory}/provider.json"
NAMA_TEST_JELLYFIN_URL="http://127.0.0.1:${jellyfin_port}/" \
NAMA_DOCKER_JELLYFIN_URL="http://jellyfin:8096/" \
NAMA_DOCKER_PROVIDER_CONFIG="${provider_configuration}" \
  node "${repository_root}/scripts/check-docker-jellyfin.mjs"
run_cli "${work_directory}/configuration-test.json" provider type test jellyfin --configuration "${provider_configuration}" --profile "${profile}"
assert_json "${work_directory}/configuration-test.json" 'value.data.connection_test.status === "connected"'
test -z "$(plugin_process_ids)" || fail "candidate plugin process did not retire"
run_cli "${work_directory}/provider-create.json" provider instance create jellyfin --display-name "Packaging Proof" --configuration "${provider_configuration}" --profile "${profile}"
provider_instance_id="$(node --input-type=module --eval 'import { readFileSync } from "node:fs"; const value = JSON.parse(readFileSync(process.argv[1], "utf8")); process.stdout.write(value.data.provider_instance.id);' "${work_directory}/provider-create.json")"
test -n "${provider_instance_id}"
initial_import_pids=""
for _ in $(seq 1 100); do
  initial_import_pids="$(plugin_process_ids)"
  if [ -n "${initial_import_pids}" ]; then
    break
  fi
  sleep 0.1
done
test -n "${initial_import_pids}" || fail "initial catalog plugin process did not start"
for _ in $(seq 1 400); do
  if [ -z "$(plugin_process_ids)" ]; then
    break
  fi
  sleep 0.1
done
test -z "$(plugin_process_ids)" || fail "initial catalog plugin process did not retire"

docker pause "${jellyfin_container_id}" >/dev/null
HOME="${cli_home}" XDG_CONFIG_HOME="${cli_home}" APPDATA="${cli_home}" \
  "${cli_binary}" provider instance test "${provider_instance_id}" --profile "${profile}" --output json \
  >"${work_directory}/interrupted-instance-test.json" 2>"${work_directory}/interrupted-instance-test-error.json" &
instance_test_process=$!
plugin_pids=""
for _ in $(seq 1 100); do
  plugin_pids="$(plugin_process_ids)"
  if [ -n "${plugin_pids}" ]; then
    break
  fi
  sleep 0.1
done
test -n "${plugin_pids}" || fail "packaged Jellyfin child was not running"
kill -0 "${instance_test_process}" || fail "provider operation exited before child interruption"
plugin_pid_values=()
while IFS= read -r value; do
  plugin_pid_values+=("${value}")
done <<<"${plugin_pids}"
request_reached_jellyfin=0
for _ in $(seq 1 100); do
  if plugin_has_jellyfin_connection "${plugin_pid_values[0]}"; then
    request_reached_jellyfin=1
    break
  fi
  kill -0 "${instance_test_process}" ||
    fail "provider operation exited before reaching Jellyfin"
  sleep 0.1
done
test "${request_reached_jellyfin}" = "1" ||
  fail "provider operation did not reach Jellyfin before child interruption"
"${runtime_compose[@]}" exec --no-TTY nama node --input-type=module --eval '
  for (const value of process.argv.slice(1)) process.kill(Number(value), "SIGKILL");
' "${plugin_pid_values[@]}"
docker unpause "${jellyfin_container_id}" >/dev/null
if wait "${instance_test_process}"; then
  fail "the interrupted provider operation unexpectedly succeeded"
fi
node --input-type=module --eval '
  const response = await fetch(new URL("health/ready", process.argv[1]));
  if (response.status !== 200) process.exit(1);
' "${nama_origin}"
run_cli "${work_directory}/instance-test-after-kill.json" provider instance test "${provider_instance_id}" --profile "${profile}"
assert_json "${work_directory}/instance-test-after-kill.json" 'value.data.connection_test.status === "connected"'

old_container_id="${container_id}"
"${runtime_compose[@]}" up --detach --no-deps --force-recreate --wait --wait-timeout 120 nama
container_id="$("${runtime_compose[@]}" ps --quiet nama)"
test "${container_id}" != "${old_container_id}"
run_cli "${work_directory}/provider-after-replacement.json" provider instance get "${provider_instance_id}" --profile "${profile}"
assert_json "${work_directory}/provider-after-replacement.json" \
  'value.data.provider_instance.id === assertionArguments[0]' "${provider_instance_id}"

"${runtime_compose[@]}" stop nama
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${container_id}")"
test "${exit_code}" = "0"
docker logs "${container_id}" >"${work_directory}/nama-stdout.log" 2>"${work_directory}/nama-stderr.log"
grep --quiet '"event":"server.stopping"' "${work_directory}/nama-stdout.log"
grep --quiet '"event":"server.stopped"' "${work_directory}/nama-stdout.log"
