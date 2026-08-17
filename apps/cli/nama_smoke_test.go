package cli_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"connectrpc.com/connect"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

func TestNamaBinaryReportsInjectedCredentialStatus(t *testing.T) {
	const token = "smoke-token"
	service := &smokeAuthService{token: token}
	mux := http.NewServeMux()
	path, handler := apiv1.NewAuthServiceHandler(service)
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd() error = %v", err)
	}
	repositoryRoot := filepath.Clean(filepath.Join(workingDirectory, "..", ".."))
	binaryName := "nama"
	if runtime.GOOS == "windows" {
		binaryName += ".exe"
	}
	binary := filepath.Join(t.TempDir(), binaryName)
	build := exec.Command("go", "build", "-o", binary, "./apps/cli/cmd/nama")
	build.Dir = repositoryRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build error = %v\n%s", err, output)
	}

	home := t.TempDir()
	environment := isolatedSmokeEnvironment(home, token)

	for _, test := range []struct {
		name string
		args []string
	}{
		{
			name: "version flag",
			args: []string{"--output", "json", "--version"},
		},
		{
			name: "completion command",
			args: []string{"--output", "json", "completion"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			stdout, stderr, err := runNama(t, binary, environment, test.args...)
			exitErr, ok := errors.AsType[*exec.ExitError](err)
			if !ok {
				t.Fatalf("nama %v error = %v, want exit status 2", test.args, err)
			}
			if got, want := exitErr.ExitCode(), 2; got != want {
				t.Errorf("nama %v exit code = %d, want %d", test.args, got, want)
			}
			if len(stdout) != 0 {
				t.Errorf("nama %v stdout = %q, want empty", test.args, stdout)
			}
			payload := decodeSingleJSON(t, stderr)
			failure, ok := payload["error"].(map[string]any)
			if !ok {
				t.Fatalf("nama %v error payload = %#v, want object", test.args, payload["error"])
			}
			if got, want := failure["code"], "invalid_argument"; got != want {
				t.Errorf("nama %v error code = %#v, want %q", test.args, got, want)
			}
		})
	}

	if _, stderr, err := runNama(t, binary, environment, "profile", "set", "smoke", "--server", server.URL, "--output", "json"); err != nil {
		t.Fatalf("nama profile set error = %v\nstderr:\n%s", err, stderr)
	}
	if _, stderr, err := runNama(t, binary, environment, "profile", "use", "smoke", "--output", "json"); err != nil {
		t.Fatalf("nama profile use error = %v\nstderr:\n%s", err, stderr)
	}

	stdout, stderr, err := runNama(t, binary, environment, "auth", "status", "--profile", "smoke", "--output", "json")
	if err != nil {
		t.Fatalf("nama auth status error = %v\nstderr:\n%s", err, stderr)
	}
	if len(stderr) != 0 {
		t.Errorf("JSON auth status stderr = %q, want empty", stderr)
	}
	payload := decodeSingleJSON(t, stdout)
	data, ok := payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("JSON auth status data = %#v, want object", payload["data"])
	}
	if got, want := data["profile"], "smoke"; got != want {
		t.Errorf("JSON profile = %#v, want %q", got, want)
	}
	if got, want := data["server"], server.URL; got != want {
		t.Errorf("JSON server = %#v, want %q", got, want)
	}
	if got, want := data["signed_in"], true; got != want {
		t.Errorf("JSON signed_in = %#v, want %t", got, want)
	}
	administrator, ok := data["administrator"].(map[string]any)
	if !ok {
		t.Fatalf("JSON administrator = %#v, want object", data["administrator"])
	}
	if got, want := administrator["email"], "smoke@example.test"; got != want {
		t.Errorf("JSON administrator email = %#v, want %q", got, want)
	}
	if bytes.Contains(stdout, []byte(token)) || bytes.Contains(stderr, []byte(token)) {
		t.Error("nama auth status leaked NAMA_TOKEN")
	}
	if got, want := service.getCurrentUserCalls, 1; got != want {
		t.Errorf("GetCurrentUser calls = %d, want %d", got, want)
	}
}

func isolatedSmokeEnvironment(home, token string) []string {
	environment := make([]string, 0, len(os.Environ())+4)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(strings.ToUpper(name), "NAMA_") ||
			strings.EqualFold(name, "HOME") ||
			strings.EqualFold(name, "XDG_CONFIG_HOME") ||
			strings.EqualFold(name, "APPDATA") {
			continue
		}
		environment = append(environment, entry)
	}
	return append(environment,
		"HOME="+home,
		"XDG_CONFIG_HOME="+home,
		"APPDATA="+home,
		"NAMA_TOKEN="+token,
	)
}

func runNama(t *testing.T, binary string, environment []string, arguments ...string) ([]byte, []byte, error) {
	t.Helper()
	command := exec.Command(binary, arguments...)
	command.Env = environment
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	if _, ok := errors.AsType[*exec.ExitError](err); err != nil && !ok {
		t.Fatalf("run nama %v: %v", arguments, err)
	}
	return stdout.Bytes(), stderr.Bytes(), err
}

func decodeSingleJSON(t *testing.T, stream []byte) map[string]any {
	t.Helper()
	if len(stream) == 0 || stream[0] != '{' || bytes.Count(stream, []byte("\n")) != 1 || !bytes.HasSuffix(stream, []byte("\n")) {
		t.Fatalf("JSON stream = %q, want exactly one object followed by one newline", stream)
	}
	decoder := json.NewDecoder(bytes.NewReader(stream))
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		t.Fatalf("JSON decode error = %v\nstream: %s", err, stream)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		t.Fatalf("JSON stream contains additional value or trailing data: %v\nstream: %s", err, stream)
	}
	return payload
}

type smokeAuthService struct {
	apiv1.UnimplementedAuthServiceHandler
	token               string
	getCurrentUserCalls int
}

func (s *smokeAuthService) GetCurrentUser(_ context.Context, request *connect.Request[apiv1.GetCurrentUserRequest]) (*connect.Response[apiv1.GetCurrentUserResponse], error) {
	s.getCurrentUserCalls++
	if got, want := request.Header().Get("Authorization"), "Bearer "+s.token; got != want {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("authorization = %q, want %q", got, want))
	}
	return connect.NewResponse(&apiv1.GetCurrentUserResponse{Administrator: &apiv1.Administrator{
		Id:          "administrator-smoke",
		DisplayName: "Smoke Admin",
		Email:       "smoke@example.test",
	}}), nil
}
