package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestProfileCommandsUseTheCobraTreeAndJSONStreams(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	dependencies := testCLIDependencies(configPath, nil, false, &cliCredentialStoreFake{}, nil, nil)

	stdout, stderr, err := executeCLI(t, dependencies, "", "profile", "set", "local", "--server", "http://127.0.0.1:8080", "--output", "json")
	if err != nil {
		t.Fatalf("profile set error = %v", err)
	}
	setPayload := decodeCLIJSON(t, stdout)
	if len(stderr) != 0 {
		t.Errorf("profile set JSON stderr = %q, want empty", stderr)
	}
	warnings, ok := setPayload["warnings"].([]any)
	if !ok || len(warnings) != 1 {
		t.Fatalf("profile set warnings = %#v, want one insecure-transport warning", setPayload["warnings"])
	}
	warning, ok := warnings[0].(map[string]any)
	if !ok || warning["code"] != "insecure_transport" {
		t.Errorf("profile set warning = %#v, want insecure_transport", warnings[0])
	}

	stdout, stderr, err = executeCLI(t, dependencies, "", "profile", "use", "local", "--output", "json")
	if err != nil {
		t.Fatalf("profile use error = %v", err)
	}
	usePayload := decodeCLIJSON(t, stdout)
	if len(stderr) != 0 {
		t.Errorf("profile use JSON stderr = %q, want empty", stderr)
	}
	warnings, ok = usePayload["warnings"].([]any)
	if !ok || len(warnings) != 1 {
		t.Fatalf("profile use warnings = %#v, want one insecure-transport warning", usePayload["warnings"])
	}
	warning, ok = warnings[0].(map[string]any)
	if !ok || warning["code"] != "insecure_transport" {
		t.Errorf("profile use warning = %#v, want insecure_transport", warnings[0])
	}
	_, humanStderr, err := executeCLI(t, dependencies, "", "profile", "use", "local")
	if err != nil {
		t.Fatalf("human profile use error = %v", err)
	}
	if !bytes.Contains(humanStderr, []byte(insecureTransportMessage)) {
		t.Errorf("human profile use stderr = %q, want insecure-transport warning prose", humanStderr)
	}
	stdout, stderr, err = executeCLI(t, dependencies, "", "profile", "list", "--output", "json")
	if err != nil {
		t.Fatalf("profile list error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("profile list JSON stderr = %q, want empty", stderr)
	}
	payload := decodeCLIJSON(t, stdout)
	data, ok := payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("profile list data = %#v, want object", payload["data"])
	}
	profiles, ok := data["profiles"].([]any)
	if !ok || len(profiles) != 1 {
		t.Fatalf("profile list profiles = %#v, want one profile", data["profiles"])
	}
	profile, ok := profiles[0].(map[string]any)
	if !ok {
		t.Fatalf("profile list entry = %#v, want object", profiles[0])
	}
	if got, want := profile["name"], "local"; got != want {
		t.Errorf("profile name = %#v, want %q", got, want)
	}
	if got, want := profile["server"], "http://127.0.0.1:8080"; got != want {
		t.Errorf("profile server = %#v, want %q", got, want)
	}
	if got, want := profile["default"], true; got != want {
		t.Errorf("profile default = %#v, want %t", got, want)
	}

	_, humanStderr, err = executeCLI(t, dependencies, "", "profile", "set", "human", "--server", "http://localhost:8081")
	if err != nil {
		t.Fatalf("human profile set error = %v", err)
	}
	if len(humanStderr) == 0 || bytes.HasPrefix(bytes.TrimSpace(humanStderr), []byte("{")) {
		t.Errorf("human profile set stderr = %q, want insecure-transport warning prose", humanStderr)
	}
}

func TestProfileSetIgnoresMissingSelectedProfile(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	dependencies := testCLIDependencies(configPath, map[string]string{
		"NAMA_PROFILE": "prod",
		"NAMA_OUTPUT":  "json",
	}, false, &cliCredentialStoreFake{}, nil, nil)

	stdout, stderr, err := executeCLI(t, dependencies, "", "profile", "set", "prod", "--server", "https://nama.example.test")
	if err != nil {
		t.Fatalf("profile set error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("profile set stderr = %q, want empty", stderr)
	}
	payload := decodeCLIJSON(t, stdout)
	data, ok := payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("profile set data = %#v, want object", payload["data"])
	}
	if got, want := data["name"], "prod"; got != want {
		t.Errorf("profile set name = %#v, want %q", got, want)
	}
}

func TestProfileListIgnoresMissingSelectedProfile(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	dependencies := testCLIDependencies(configPath, map[string]string{
		"NAMA_PROFILE": "missing",
		"NAMA_OUTPUT":  "json",
	}, false, &cliCredentialStoreFake{}, nil, nil)

	stdout, stderr, err := executeCLI(t, dependencies, "", "profile", "list")
	if err != nil {
		t.Fatalf("profile list error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("profile list stderr = %q, want empty", stderr)
	}
	payload := decodeCLIJSON(t, stdout)
	data, ok := payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("profile list data = %#v, want object", payload["data"])
	}
	profiles, ok := data["profiles"].([]any)
	if !ok {
		t.Fatalf("profile list profiles = %#v, want array", data["profiles"])
	}
	if len(profiles) != 0 {
		t.Errorf("profile list profiles = %#v, want empty", profiles)
	}
}

func TestProfileListAndUseIgnoreServerEnvironment(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	credentials := &cliCredentialStoreFake{}
	setDependencies := testCLIDependencies(configPath, map[string]string{
		"NAMA_OUTPUT": "json",
	}, false, credentials, nil, nil)
	setProfile(t, setDependencies, "prod", "https://nama.example.test")

	dependencies := testCLIDependencies(configPath, map[string]string{
		"NAMA_SERVER": "not-a-server-url",
		"NAMA_OUTPUT": "json",
	}, false, credentials, nil, nil)
	for _, arguments := range [][]string{
		{"profile", "list"},
		{"profile", "use", "prod"},
	} {
		stdout, stderr, err := executeCLI(t, dependencies, "", arguments...)
		if err != nil {
			t.Errorf("%v error = %v", arguments, err)
		}
		if len(stdout) == 0 {
			t.Errorf("%v stdout = empty, want JSON success", arguments)
		}
		if len(stderr) != 0 {
			t.Errorf("%v stderr = %q, want empty", arguments, stderr)
		}
	}
}

func TestSetupAndLoginSelectNonInteractiveSecretsWithoutLeakingThem(t *testing.T) {
	const (
		bootstrapToken = "bootstrap-secret"
		password       = "correct-horse-battery-staple"
		bearer         = "bearer-secret"
	)
	configPath := filepath.Join(t.TempDir(), "config.json")
	credentials := &cliCredentialStoreFake{}
	setupClient := &cliSetupServiceFake{
		status: &apiv1.GetStatusResponse{},
		create: &apiv1.CreateAdministratorResponse{Administrator: cliAdministrator()},
	}
	authClient := &cliAuthServiceFake{signIn: &apiv1.SignInResponse{
		Administrator: cliAdministrator(),
		Credential: &apiv1.BearerCredential{
			Token:     bearer,
			ExpiresAt: timestamppb.New(time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)),
		},
	}}
	dependencies := testCLIDependencies(configPath, map[string]string{"NAMA_BOOTSTRAP_TOKEN": bootstrapToken}, false, credentials, setupClient, authClient)
	setProfile(t, dependencies, "work", "https://nama.example.test")

	stdout, stderr, err := executeCLI(t, dependencies, password+"\nignored\n", "setup", "--profile", "work", "--display-name", "Nama Admin", "--email", "admin@example.test", "--output", "json")
	if err != nil {
		t.Fatalf("setup error = %v", err)
	}
	decodeCLIJSON(t, stdout)
	if len(stderr) != 0 {
		t.Errorf("setup JSON stderr = %q, want empty", stderr)
	}
	if setupClient.createRequest == nil {
		t.Fatal("setup did not call CreateAdministrator")
	} else if got := setupClient.createRequest.Msg; got.GetBootstrapToken() != bootstrapToken || got.GetPassword() != password {
		t.Errorf("setup request = %#v, want bootstrap token and first password line", got)
	}
	if authClient.signInRequest == nil {
		t.Fatal("setup did not call SignIn")
	} else if got := authClient.signInRequest.Msg; got.GetPassword() != password {
		t.Errorf("setup sign-in request = %#v, want first password line", got)
	}
	for _, stream := range [][]byte{stdout, stderr} {
		if bytes.Contains(stream, []byte(bootstrapToken)) || bytes.Contains(stream, []byte(password)) || bytes.Contains(stream, []byte(bearer)) {
			t.Errorf("setup stream leaked secret: %q", stream)
		}
	}

	loginPassword := "new-password"
	authClient.signIn = &apiv1.SignInResponse{
		Administrator: cliAdministrator(),
		Credential: &apiv1.BearerCredential{
			Token:     "replacement-bearer",
			ExpiresAt: timestamppb.New(time.Date(2026, time.August, 17, 13, 0, 0, 0, time.UTC)),
		},
	}
	stdout, stderr, err = executeCLI(t, dependencies, loginPassword+"\n", "auth", "login", "--profile", "work", "--email", "admin@example.test", "--output", "json")
	if err != nil {
		t.Fatalf("auth login error = %v", err)
	}
	decodeCLIJSON(t, stdout)
	if len(stderr) != 0 {
		t.Errorf("auth login JSON stderr = %q, want empty", stderr)
	}
	if authClient.signInRequest == nil {
		t.Fatal("auth login did not call SignIn")
	} else if got := authClient.signInRequest.Msg.GetPassword(); got != loginPassword {
		t.Errorf("auth login password = %q, want stdin password", got)
	}
	if bytes.Contains(stdout, []byte(loginPassword)) || bytes.Contains(stdout, []byte("replacement-bearer")) || bytes.Contains(stderr, []byte(loginPassword)) || bytes.Contains(stderr, []byte("replacement-bearer")) {
		t.Error("auth login stream leaked a secret")
	}
}

func TestRootFlagsAndEnvironmentResolveBeforeProfileDefaults(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	credentials := &cliCredentialStoreFake{}
	dependencies := testCLIDependencies(configPath, nil, false, credentials, nil, &cliAuthServiceFake{})
	setProfile(t, dependencies, "alpha", "https://alpha.example.test")
	setProfile(t, dependencies, "bravo", "https://bravo.example.test")
	if _, _, err := executeCLI(t, dependencies, "", "profile", "use", "alpha", "--output", "json"); err != nil {
		t.Fatalf("profile use error = %v", err)
	}

	for _, test := range []struct {
		name    string
		env     map[string]string
		args    []string
		profile string
		server  string
	}{
		{
			name:    "environment profile wins over configured default",
			env:     map[string]string{"NAMA_PROFILE": "bravo", "NAMA_OUTPUT": "json"},
			args:    []string{"auth", "status"},
			profile: "bravo",
			server:  "https://bravo.example.test",
		},
		{
			name:    "profile flag wins over environment",
			env:     map[string]string{"NAMA_PROFILE": "bravo", "NAMA_OUTPUT": "json"},
			args:    []string{"auth", "status", "--profile", "alpha"},
			profile: "alpha",
			server:  "https://alpha.example.test",
		},
		{
			name:    "server environment wins over selected profile",
			env:     map[string]string{"NAMA_SERVER": "https://environment.example.test", "NAMA_OUTPUT": "json"},
			args:    []string{"auth", "status"},
			profile: "alpha",
			server:  "https://environment.example.test",
		},
		{
			name:    "server flag wins over environment",
			env:     map[string]string{"NAMA_SERVER": "https://environment.example.test", "NAMA_OUTPUT": "json"},
			args:    []string{"auth", "status", "--server", "https://flag.example.test"},
			profile: "alpha",
			server:  "https://flag.example.test",
		},
		{
			name:    "output flag wins over environment",
			env:     map[string]string{"NAMA_OUTPUT": "human"},
			args:    []string{"auth", "status", "--output", "json"},
			profile: "alpha",
			server:  "https://alpha.example.test",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			dependencies := testCLIDependencies(configPath, test.env, false, credentials, nil, &cliAuthServiceFake{})
			stdout, stderr, err := executeCLI(t, dependencies, "", test.args...)
			if err != nil {
				t.Fatalf("auth status error = %v", err)
			}
			if len(stderr) != 0 {
				t.Errorf("auth status JSON stderr = %q, want empty", stderr)
			}
			data := decodeCLIData(t, stdout)
			if got, want := data["profile"], test.profile; got != want {
				t.Errorf("status profile = %#v, want %q", got, want)
			}
			if got, want := data["server"], test.server; got != want {
				t.Errorf("status server = %#v, want %q", got, want)
			}

			if got, want := data["signed_in"], false; got != want {
				t.Errorf("status signed_in = %#v, want %t", got, want)
			}
		})
	}
}

func TestRootRejectsExplicitEmptyGlobalFlagsBeforeFallbackOrSignIn(t *testing.T) {
	const server = "https://work.example.test"
	previous := auth.Credential{
		Token:     "existing-bearer",
		ExpiresAt: time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC),
	}

	for _, test := range []struct {
		name string
		env  map[string]string
		args []string
	}{
		{
			name: "server flag",
			env: map[string]string{
				"NAMA_SERVER": server,
				"NAMA_OUTPUT": "json",
			},
			args: []string{"auth", "login", "--server=", "--email", "admin@example.test"},
		},
		{
			name: "profile flag",
			env: map[string]string{
				"NAMA_PROFILE": "work",
				"NAMA_OUTPUT":  "json",
			},
			args: []string{"auth", "login", "--profile=", "--email", "admin@example.test"},
		},
		{
			name: "output flag",
			env: map[string]string{
				"NAMA_OUTPUT": "json",
			},
			args: []string{"auth", "login", "--output=", "--email", "admin@example.test"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			configPath := filepath.Join(t.TempDir(), "config.json")
			credentials := &cliCredentialStoreFake{credential: previous, exists: true}
			bootstrapDependencies := testCLIDependencies(configPath, nil, false, credentials, nil, nil)
			setProfile(t, bootstrapDependencies, "work", server)
			if _, _, err := executeCLI(t, bootstrapDependencies, "", "profile", "use", "work", "--output", "json"); err != nil {
				t.Fatalf("profile use error = %v", err)
			}

			authClient := &cliAuthServiceFake{signIn: &apiv1.SignInResponse{
				Administrator: cliAdministrator(),
				Credential: &apiv1.BearerCredential{
					Token:     "replacement-bearer",
					ExpiresAt: timestamppb.New(time.Date(2026, time.August, 17, 13, 0, 0, 0, time.UTC)),
				},
			}}
			dependencies := testCLIDependencies(configPath, test.env, false, credentials, nil, authClient)

			stdout, stderr, err := executeCLI(t, dependencies, "password\n", test.args...)

			requireCLIError(t, err, "invalid_argument", 2)
			if len(stdout) != 0 {
				t.Errorf("explicit empty %s stdout = %q, want empty", test.name, stdout)
			}
			payload := decodeCLIJSON(t, stderr)
			failure, ok := payload["error"].(map[string]any)
			if !ok {
				t.Fatalf("explicit empty %s error = %#v, want object", test.name, payload["error"])
			}
			if got, want := failure["code"], "invalid_argument"; got != want {
				t.Errorf("explicit empty %s error code = %#v, want %q", test.name, got, want)
			}
			if authClient.signInRequest != nil {
				t.Errorf("explicit empty %s flag called SignIn", test.name)
			}
			if !credentials.exists || !reflect.DeepEqual(credentials.credential, previous) {
				t.Errorf("explicit empty %s flag mutated credential = %#v, exists = %t; want %#v, true", test.name, credentials.credential, credentials.exists, previous)
			}
		})
	}
}

func TestRootRejectsUnsupportedTopLevelCommands(t *testing.T) {
	dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), nil, false, &cliCredentialStoreFake{}, nil, nil)

	for _, test := range []struct {
		name string
		args []string
	}{
		{
			name: "misspelled command",
			args: []string{"--output", "json", "profle"},
		},
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
			stdout, stderr, err := executeCLI(t, dependencies, "", test.args...)
			requireCLIError(t, err, "invalid_argument", 2)
			if len(stdout) != 0 {
				t.Errorf("unsupported command stdout = %q, want empty", stdout)
			}
			payload := decodeCLIJSON(t, stderr)
			failure, ok := payload["error"].(map[string]any)
			if !ok {
				t.Fatalf("unsupported command error = %#v, want object", payload["error"])
			}
			if got, want := failure["code"], "invalid_argument"; got != want {
				t.Errorf("unsupported command error code = %#v, want %q", got, want)
			}
		})
	}
}

func TestRootSelectsOutputForArgumentErrorsFromRawArguments(t *testing.T) {
	for _, test := range []struct {
		name     string
		env      map[string]string
		args     []string
		wantJSON bool
	}{
		{
			name:     "genuine output after an unknown flag",
			args:     []string{"auth", "status", "--unknown", "--output", "json"},
			wantJSON: true,
		},
		{
			name: "server consumes output",
			env:  map[string]string{"NAMA_OUTPUT": "human"},
			args: []string{"auth", "status", "--server", "--output", "json"},
		},
		{
			name: "profile consumes output",
			env:  map[string]string{"NAMA_OUTPUT": "human"},
			args: []string{"auth", "status", "--profile", "--output", "json"},
		},
		{
			name: "email consumes output",
			env:  map[string]string{"NAMA_OUTPUT": "human"},
			args: []string{"auth", "login", "--email", "--output", "json"},
		},
		{
			name: "display name consumes output",
			env:  map[string]string{"NAMA_OUTPUT": "human"},
			args: []string{"setup", "--display-name", "--output", "json"},
		},
		{
			name: "literal separator terminates scanning",
			env:  map[string]string{"NAMA_OUTPUT": "human"},
			args: []string{"auth", "status", "--", "--output", "json"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), test.env, false, &cliCredentialStoreFake{}, nil, nil)

			stdout, stderr, err := executeCLI(t, dependencies, "", test.args...)
			requireCLIError(t, err, "invalid_argument", 2)
			if len(stdout) != 0 {
				t.Errorf("argument-error stdout = %q, want empty", stdout)
			}

			if test.wantJSON {
				payload := decodeCLIJSON(t, stderr)
				failure, ok := payload["error"].(map[string]any)
				if !ok {
					t.Fatalf("argument-error JSON error = %#v, want object", payload["error"])
				}
				if got, want := failure["code"], "invalid_argument"; got != want {
					t.Errorf("argument-error JSON code = %#v, want %q", got, want)
				}
				return
			}

			if len(stderr) == 0 || bytes.HasPrefix(bytes.TrimSpace(stderr), []byte("{")) {
				t.Errorf("argument-error stderr = %q, want human error prose", stderr)
			}
		})
	}
}

func TestStatusWithoutProfileUsesInjectedCredentialAndOmitsProfileFromJSON(t *testing.T) {
	const token = "injected-token"
	credentials := &cliCredentialStoreFake{
		credential: auth.Credential{Token: token, Injected: true},
		exists:     true,
	}
	client := &cliAuthServiceFake{currentUser: &apiv1.GetCurrentUserResponse{Administrator: cliAdministrator()}}
	dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), map[string]string{
		"NAMA_OUTPUT": "json",
		"NAMA_TOKEN":  token,
	}, false, credentials, nil, client)

	stdout, stderr, err := executeCLI(t, dependencies, "", "auth", "status", "--server", "https://override.example.test")
	if err != nil {
		t.Fatalf("auth status error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("auth status JSON stderr = %q, want empty", stderr)
	}
	data := decodeCLIData(t, stdout)
	if _, present := data["profile"]; present {
		t.Errorf("status data profile = %#v, want omitted without selected profile", data["profile"])
	}
	if got, want := data["server"], "https://override.example.test"; got != want {
		t.Errorf("status server = %#v, want %q", got, want)
	}
	if got, want := data["signed_in"], true; got != want {
		t.Errorf("status signed_in = %#v, want %t", got, want)
	}
	if bytes.Contains(stdout, []byte(token)) {
		t.Error("status JSON leaked NAMA_TOKEN")
	}
}

func TestNonInteractiveSetupRequiresBootstrapTokenAndNeverAcceptsPasswordFlag(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	setupClient := &cliSetupServiceFake{}
	authClient := &cliAuthServiceFake{}
	environment := map[string]string{"NAMA_OUTPUT": "json"}
	dependencies := testCLIDependencies(configPath, environment, false, &cliCredentialStoreFake{}, setupClient, authClient)
	setProfile(t, dependencies, "work", "https://nama.example.test")

	stdout, stderr, err := executeCLI(t, dependencies, "password\n", "setup", "--profile", "work", "--display-name", "Nama Admin", "--email", "admin@example.test")
	requireCLIError(t, err, "invalid_argument", 2)
	if len(stdout) != 0 {
		t.Errorf("missing-token stdout = %q, want empty", stdout)
	}
	decodeCLIJSON(t, stderr)
	if bytes.Contains(stderr, []byte("password")) {
		t.Error("missing-token error leaked password")
	}
	if setupClient.statusCalls != 0 {
		t.Errorf("GetStatus calls = %d, want 0 without bootstrap token", setupClient.statusCalls)
	}

	environment["NAMA_BOOTSTRAP_TOKEN"] = "bootstrap-secret"
	stdout, stderr, err = executeCLI(t, dependencies, "\n", "setup", "--profile", "work", "--display-name", "Nama Admin", "--email", "admin@example.test")
	requireCLIError(t, err, "invalid_argument", 2)
	if len(stdout) != 0 {
		t.Errorf("empty setup password stdout = %q, want empty", stdout)
	}
	decodeCLIJSON(t, stderr)
	if setupClient.statusCalls != 0 || setupClient.createRequest != nil || authClient.signInRequest != nil {
		t.Error("empty setup password called an API")
	}

	stdout, stderr, err = executeCLI(t, dependencies, "\n", "auth", "login", "--profile", "work", "--email", "admin@example.test")
	requireCLIError(t, err, "invalid_argument", 2)
	if len(stdout) != 0 {
		t.Errorf("empty login password stdout = %q, want empty", stdout)
	}
	decodeCLIJSON(t, stderr)
	if authClient.signInRequest != nil {
		t.Error("empty login password called SignIn")
	}

	stdout, stderr, err = executeCLI(t, dependencies, "", "auth", "login", "--password", "password", "--output", "json")
	requireCLIError(t, err, "invalid_argument", 2)
	if len(stdout) != 0 {
		t.Errorf("password-flag stdout = %q, want empty", stdout)
	}
	decodeCLIJSON(t, stderr)

	authClient.signInErr = connect.NewError(connect.CodeUnauthenticated, errors.New("authentication failed"))
	stdout, stderr, err = executeCLI(t, dependencies, "password\n", "auth", "login", "--profile", "work", "--email", "admin@example.test", "--output", "json")
	requireCLIError(t, err, "unauthenticated", 3)
	if len(stdout) != 0 {
		t.Errorf("authentication failure stdout = %q, want empty", stdout)
	}
	decodeCLIJSON(t, stderr)
	if bytes.Contains(stderr, []byte("password")) {
		t.Error("authentication failure leaked password")
	}
}

func TestSetupAndLoginTreatSecretInputIOFailuresAsUnexpected(t *testing.T) {
	const (
		bootstrapToken = "bootstrap-secret"
		stdinSecret    = "stdin-secret"
	)

	tests := []struct {
		name          string
		args          []string
		source        string
		privateCause  string
		privateValues []string
	}{
		{
			name:          "setup terminal reader",
			args:          []string{"setup", "--profile", "work", "--display-name", "Nama Admin", "--email", "admin@example.test"},
			source:        "terminal reader",
			privateCause:  "terminal-reader-cause terminal-reader-secret",
			privateValues: []string{"terminal-reader-cause", "terminal-reader-secret"},
		},
		{
			name:          "login terminal reader",
			args:          []string{"auth", "login", "--profile", "work", "--email", "admin@example.test"},
			source:        "terminal reader",
			privateCause:  "terminal-reader-cause terminal-reader-secret",
			privateValues: []string{"terminal-reader-cause", "terminal-reader-secret"},
		},
		{
			name:          "setup stdin reader",
			args:          []string{"setup", "--profile", "work", "--display-name", "Nama Admin", "--email", "admin@example.test"},
			source:        "stdin reader",
			privateCause:  "stdin-reader-cause",
			privateValues: []string{"stdin-reader-cause", "is a directory"},
		},
		{
			name:          "login stdin reader",
			args:          []string{"auth", "login", "--profile", "work", "--email", "admin@example.test"},
			source:        "stdin reader",
			privateCause:  "stdin-reader-cause",
			privateValues: []string{"stdin-reader-cause", "is a directory"},
		},
		{
			name:          "setup prompt writer",
			args:          []string{"setup", "--profile", "work", "--display-name", "Nama Admin", "--email", "admin@example.test"},
			source:        "prompt writer",
			privateCause:  "prompt-writer-cause prompt-writer-secret",
			privateValues: []string{"prompt-writer-cause", "prompt-writer-secret"},
		},
		{
			name:          "login prompt writer",
			args:          []string{"auth", "login", "--profile", "work", "--email", "admin@example.test"},
			source:        "prompt writer",
			privateCause:  "prompt-writer-cause prompt-writer-secret",
			privateValues: []string{"prompt-writer-cause", "prompt-writer-secret"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setupClient := &cliSetupServiceFake{
				status: &apiv1.GetStatusResponse{},
				create: &apiv1.CreateAdministratorResponse{Administrator: cliAdministrator()},
			}
			authClient := &cliAuthServiceFake{signIn: &apiv1.SignInResponse{
				Administrator: cliAdministrator(),
				Credential: &apiv1.BearerCredential{
					Token:     "bearer-secret",
					ExpiresAt: timestamppb.New(time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)),
				},
			}}
			dependencies := testCLIDependencies(
				filepath.Join(t.TempDir(), "config.json"),
				map[string]string{"NAMA_BOOTSTRAP_TOKEN": bootstrapToken},
				test.source != "stdin reader",
				&cliCredentialStoreFake{},
				setupClient,
				authClient,
			)
			setProfile(t, dependencies, "work", "https://nama.example.test")

			input := cliStdin(t, stdinSecret+"\n")
			var stdout bytes.Buffer
			var standardErr bytes.Buffer
			var errorWriter io.Writer = &standardErr
			var passwordReader *cliPasswordReaderSpy
			var promptWriter *cliFailOnceWriter

			switch test.source {
			case "terminal reader":
				passwordReader = &cliPasswordReaderSpy{err: errors.New(test.privateCause)}
				dependencies.SecretInput.TerminalReader = passwordReader
			case "stdin reader":
				stdinDirectory := filepath.Join(t.TempDir(), test.privateCause)
				if err := os.Mkdir(stdinDirectory, 0o700); err != nil {
					t.Fatalf("os.Mkdir(%q) error = %v", stdinDirectory, err)
				}
				var err error
				input, err = os.Open(stdinDirectory)
				if err != nil {
					t.Fatalf("os.Open(%q) error = %v", stdinDirectory, err)
				}
				t.Cleanup(func() {
					if err := input.Close(); err != nil {
						t.Errorf("stdin close error = %v", err)
					}
				})
			case "prompt writer":
				passwordReader = &cliPasswordReaderSpy{}
				dependencies.SecretInput.TerminalReader = passwordReader
				promptWriter = &cliFailOnceWriter{err: errors.New(test.privateCause)}
				errorWriter = promptWriter
			default:
				t.Fatalf("unknown secret input failure source %q", test.source)
			}

			err := executeCLIWithStreams(t, dependencies, input, &stdout, errorWriter, test.args...)
			stderr := standardErr.Bytes()
			if promptWriter != nil {
				stderr = promptWriter.Bytes()
				if got := promptWriter.calls; got < 2 {
					t.Errorf("prompt writer calls = %d, want prompt and error rendering", got)
				}
			}

			requireCLIError(t, err, "unexpected_failure", 1)
			if len(stdout.Bytes()) != 0 {
				t.Errorf("%s stdout = %q, want empty", test.name, stdout.Bytes())
			}
			if !bytes.Contains(stderr, []byte("The request could not be completed.")) {
				t.Errorf("%s stderr = %q, want safe unexpected-failure message", test.name, stderr)
			}
			privateValues := append([]string{bootstrapToken, stdinSecret}, test.privateValues...)
			requireNoCLILeak(t, stdout.Bytes(), privateValues...)
			requireNoCLILeak(t, stderr, privateValues...)
			if setupClient.statusCalls != 0 || setupClient.createRequest != nil || authClient.signInRequest != nil {
				t.Errorf("%s called an API", test.name)
			}
			if passwordReader != nil {
				switch test.source {
				case "terminal reader":
					if got := passwordReader.calls; got != 1 {
						t.Errorf("terminal reader calls = %d, want 1", got)
					}
				case "prompt writer":
					if got := passwordReader.calls; got != 0 {
						t.Errorf("prompt writer failure read a secret %d times, want 0", got)
					}
				}
			}
		})
	}
}

func TestTerminalJSONSecretInputRendersInvalidArgument(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
	}{
		{
			name: "setup",
			args: []string{"setup", "--profile", "work", "--display-name", "Nama Admin", "--email", "admin@example.test", "--output", "json"},
		},
		{
			name: "login",
			args: []string{"auth", "login", "--profile", "work", "--email", "admin@example.test", "--output", "json"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupClient := &cliSetupServiceFake{
				status: &apiv1.GetStatusResponse{},
				create: &apiv1.CreateAdministratorResponse{Administrator: cliAdministrator()},
			}
			authClient := &cliAuthServiceFake{signIn: &apiv1.SignInResponse{
				Administrator: cliAdministrator(),
				Credential: &apiv1.BearerCredential{
					Token:     "bearer-secret",
					ExpiresAt: timestamppb.New(time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)),
				},
			}}
			dependencies := testCLIDependencies(
				filepath.Join(t.TempDir(), "config.json"),
				map[string]string{"NAMA_BOOTSTRAP_TOKEN": "bootstrap-secret"},
				true,
				&cliCredentialStoreFake{},
				setupClient,
				authClient,
			)
			terminalReader := &cliPasswordReaderSpy{}
			dependencies.SecretInput.TerminalReader = terminalReader
			setProfile(t, dependencies, "work", "https://nama.example.test")

			stdout, stderr, err := executeCLI(t, dependencies, "stdin-password\n", test.args...)

			requireCLIError(t, err, "invalid_argument", 2)
			if len(stdout) != 0 {
				t.Errorf("terminal JSON %s stdout = %q, want empty", test.name, stdout)
			}
			payload := decodeCLIJSON(t, stderr)
			failure, ok := payload["error"].(map[string]any)
			if !ok {
				t.Fatalf("terminal JSON %s error = %#v, want object", test.name, payload["error"])
			}
			if got, want := failure["code"], "invalid_argument"; got != want {
				t.Errorf("terminal JSON %s error code = %#v, want %q", test.name, got, want)
			}
			if got := terminalReader.calls; got != 0 {
				t.Errorf("terminal reader calls = %d, want 0", got)
			}
			if setupClient.statusCalls != 0 || setupClient.createRequest != nil || authClient.signInRequest != nil {
				t.Error("terminal JSON secret input called an API")
			}
		})
	}
}

func TestSetupAndLoginRejectServerOverrideThatDiffersFromProfile(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	setupClient := &cliSetupServiceFake{}
	authClient := &cliAuthServiceFake{}
	dependencies := testCLIDependencies(configPath, map[string]string{
		"NAMA_BOOTSTRAP_TOKEN": "bootstrap-secret",
		"NAMA_OUTPUT":          "json",
	}, false, &cliCredentialStoreFake{}, setupClient, authClient)
	setProfile(t, dependencies, "work", "https://nama.example.test")

	for _, test := range []struct {
		name string
		args []string
	}{
		{
			name: "setup",
			args: []string{"setup", "--profile", "work", "--server", "https://override.example.test", "--display-name", "Nama Admin", "--email", "admin@example.test"},
		},
		{
			name: "login",
			args: []string{"auth", "login", "--profile", "work", "--server", "https://override.example.test", "--email", "admin@example.test"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			stdout, stderr, err := executeCLI(t, dependencies, "password\n", test.args...)
			requireCLIError(t, err, "invalid_argument", 2)
			if len(stdout) != 0 {
				t.Errorf("override stdout = %q, want empty", stdout)
			}
			decodeCLIJSON(t, stderr)
		})
	}
	if setupClient.statusCalls != 0 {
		t.Errorf("GetStatus calls = %d, want 0 for rejected override", setupClient.statusCalls)
	}
	if authClient.signInRequest != nil {
		t.Error("SignIn was called for rejected override")
	}
}

func setProfile(t *testing.T, dependencies Dependencies, name, server string) {
	t.Helper()
	if _, _, err := executeCLI(t, dependencies, "", "profile", "set", name, "--server", server, "--output", "json"); err != nil {
		t.Fatalf("profile set %q error = %v", name, err)
	}
}

func executeCLI(t *testing.T, dependencies Dependencies, stdin string, arguments ...string) ([]byte, []byte, error) {
	t.Helper()
	input := cliStdin(t, stdin)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	err := executeCLIWithStreams(t, dependencies, input, &stdout, &stderr, arguments...)
	return stdout.Bytes(), stderr.Bytes(), err
}

func executeCLIWithStreams(t *testing.T, dependencies Dependencies, input *os.File, stdout, stderr io.Writer, arguments ...string) error {
	t.Helper()
	dependencies.SecretInput.Stdin = input
	dependencies.RawArgs = slices.Clone(arguments)
	command := NewRootCommand(dependencies)
	command.SetArgs(arguments)
	command.SetIn(input)
	command.SetOut(stdout)
	command.SetErr(stderr)
	return command.ExecuteContext(t.Context())
}

func testCLIDependencies(configPath string, environment map[string]string, terminal bool, credentials auth.CredentialStore, setupClient apiv1.SetupServiceClient, authClient apiv1.AuthServiceClient) Dependencies {
	return Dependencies{
		ConfigPath:  configPath,
		Credentials: credentials,
		SetupClient: setupClient,
		AuthClient:  authClient,
		SecretInput: auth.SecretInput{
			Terminal: terminal,
			Getenv:   func(name string) string { return environment[name] },
		},
	}
}

func cliStdin(t *testing.T, input string) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stdin")
	if err != nil {
		t.Fatalf("os.CreateTemp() error = %v", err)
	}
	t.Cleanup(func() {
		if err := file.Close(); err != nil {
			t.Errorf("stdin close error = %v", err)
		}
	})
	if _, err := file.WriteString(input); err != nil {
		t.Fatalf("stdin write error = %v", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatalf("stdin seek error = %v", err)
	}
	return file
}

func decodeCLIData(t *testing.T, stream []byte) map[string]any {
	t.Helper()
	payload := decodeCLIJSON(t, stream)
	data, ok := payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("JSON data = %#v, want object", payload["data"])
	}
	return data
}

func decodeCLIJSON(t *testing.T, stream []byte) map[string]any {
	t.Helper()
	if len(stream) == 0 || stream[0] != '{' || bytes.Count(stream, []byte("\n")) != 1 || !bytes.HasSuffix(stream, []byte("\n")) {
		t.Fatalf("JSON stream = %q, want exactly one object followed by one newline", stream)
	}
	decoder := json.NewDecoder(bytes.NewReader(stream))
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		t.Fatalf("decode JSON stream: %v\n%s", err, stream)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {

		t.Fatalf("JSON stream contains trailing data: %v\n%s", err, stream)
	}
	return payload
}

func requireCLIError(t *testing.T, err error, wantCode string, wantExitCode int) {
	t.Helper()
	cliErr, ok := errors.AsType[*clierror.Error](err)
	if !ok {
		t.Fatalf("command error = %T %v, want *clierror.Error", err, err)
	}
	if got := cliErr.Code; got != wantCode {
		t.Errorf("error code = %q, want %q", got, wantCode)
	}
	if got := cliErr.ExitCode(); got != wantExitCode {
		t.Errorf("exit code = %d, want %d", got, wantExitCode)
	}
}

func requireNoCLILeak(t *testing.T, stream []byte, privateValues ...string) {
	t.Helper()
	for _, value := range privateValues {
		if bytes.Contains(stream, []byte(value)) {
			t.Errorf("stream leaked %q: %q", value, stream)
		}
	}
}

func cliAdministrator() *apiv1.Administrator {
	return &apiv1.Administrator{
		Id:          "administrator-1",
		DisplayName: "Nama Admin",
		Email:       "admin@example.test",
	}
}

type cliPasswordReaderSpy struct {
	calls  int
	values [][]byte
	err    error
}

func (r *cliPasswordReaderSpy) ReadPassword(int) ([]byte, error) {
	r.calls++
	if r.err != nil {
		return nil, r.err
	}
	if index := r.calls - 1; index < len(r.values) {
		return r.values[index], nil
	}
	return []byte("terminal-secret"), nil
}

type cliFailOnceWriter struct {
	err    error
	calls  int
	output bytes.Buffer
}

func (w *cliFailOnceWriter) Write(value []byte) (int, error) {
	w.calls++
	if w.calls == 1 {
		return 0, w.err
	}
	return w.output.Write(value)
}

func (w *cliFailOnceWriter) Bytes() []byte {
	return w.output.Bytes()
}

type cliCredentialStoreFake struct {
	credential auth.Credential
	exists     bool
	err        error
}

func (f *cliCredentialStoreFake) Get(context.Context, string) (auth.Credential, bool, error) {
	return f.credential, f.exists, f.err
}

func (f *cliCredentialStoreFake) Put(_ context.Context, _ string, credential auth.Credential) error {
	f.credential = credential
	f.exists = true
	return f.err
}

func (f *cliCredentialStoreFake) Delete(_ context.Context, _ string) error {
	f.credential = auth.Credential{}
	f.exists = false
	return f.err
}

type cliSetupServiceFake struct {
	status        *apiv1.GetStatusResponse
	create        *apiv1.CreateAdministratorResponse
	statusErr     error
	createErr     error
	statusCalls   int
	createRequest *connect.Request[apiv1.CreateAdministratorRequest]
}

func (f *cliSetupServiceFake) GetStatus(context.Context, *connect.Request[apiv1.GetStatusRequest]) (*connect.Response[apiv1.GetStatusResponse], error) {
	f.statusCalls++
	if f.statusErr != nil {
		return nil, f.statusErr
	}
	return connect.NewResponse(f.status), nil
}

func (f *cliSetupServiceFake) CreateAdministrator(_ context.Context, request *connect.Request[apiv1.CreateAdministratorRequest]) (*connect.Response[apiv1.CreateAdministratorResponse], error) {
	f.createRequest = request
	if f.createErr != nil {
		return nil, f.createErr
	}
	return connect.NewResponse(f.create), nil
}

type cliAuthServiceFake struct {
	signIn             *apiv1.SignInResponse
	signInErr          error
	signInRequest      *connect.Request[apiv1.SignInRequest]
	currentUser        *apiv1.GetCurrentUserResponse
	currentUserErr     error
	currentUserRequest *connect.Request[apiv1.GetCurrentUserRequest]
}

func (f *cliAuthServiceFake) SignIn(_ context.Context, request *connect.Request[apiv1.SignInRequest]) (*connect.Response[apiv1.SignInResponse], error) {
	f.signInRequest = request
	if f.signInErr != nil {
		return nil, f.signInErr
	}
	return connect.NewResponse(f.signIn), nil
}

func (f *cliAuthServiceFake) GetCurrentUser(_ context.Context, request *connect.Request[apiv1.GetCurrentUserRequest]) (*connect.Response[apiv1.GetCurrentUserResponse], error) {
	f.currentUserRequest = request
	if f.currentUserErr != nil {
		return nil, f.currentUserErr
	}
	return connect.NewResponse(f.currentUser), nil
}

func (*cliAuthServiceFake) SignOut(context.Context, *connect.Request[apiv1.SignOutRequest]) (*connect.Response[apiv1.SignOutResponse], error) {
	return nil, errors.New("unexpected SignOut call")
}
