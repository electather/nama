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
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"google.golang.org/protobuf/types/known/structpb"
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

func TestProviderDeleteRequiresExplicitAutomationConsentAndInteractiveConfirmation(t *testing.T) {
	const (
		profileName        = "local"
		providerInstanceID = "provider-instance-1"
		revision           = "revision-2"
		server             = "http://127.0.0.1:8080"
		token              = "administrator-bearer"
	)
	configPath := filepath.Join(t.TempDir(), "config.json")
	credentials := &cliCredentialStoreFake{
		credential: auth.Credential{
			Token:     token,
			ExpiresAt: time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC),
			Server:    server,
		},
		exists: true,
	}
	providerClient := &cliProviderServiceFake{}
	dependencies := testCLIDependencies(configPath, nil, false, credentials, nil, nil)
	dependencies.ProviderClient = providerClient
	setProfile(t, dependencies, profileName, server)

	stdout, stderr, err := executeCLI(
		t,
		dependencies,
		"",
		"provider",
		"instance",
		"delete",
		providerInstanceID,
		"--expected-revision",
		revision,
		"--profile",
		profileName,
		"--output",
		"json",
	)
	requireCLIError(t, err, clierror.CodeInvalidArgument, 2)
	if len(stdout) != 0 || len(stderr) == 0 {
		t.Errorf("unconfirmed noninteractive delete stdout=%q stderr=%q, want only an error", stdout, stderr)
	}
	if providerClient.deleteRequest != nil {
		t.Fatal("unconfirmed noninteractive delete called the server")
	}

	stdout, stderr, err = executeCLI(
		t,
		dependencies,
		"",
		"provider",
		"instance",
		"delete",
		providerInstanceID,
		"--expected-revision",
		revision,
		"--operation-id",
		"delete-operation",
		"--yes",
		"--profile",
		profileName,
		"--output",
		"json",
	)
	if err != nil {
		t.Fatalf("confirmed noninteractive delete error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("confirmed noninteractive delete stderr = %q, want empty", stderr)
	}
	if got, want := decodeCLIData(t, stdout)["operation_id"], "delete-operation"; got != want {
		t.Errorf("delete operation ID = %#v, want %q", got, want)
	}
	if providerClient.deleteRequest == nil {
		t.Fatal("confirmed noninteractive delete did not call the server")
	}
	if got, want := providerClient.deleteRequest.Msg.GetProviderInstanceId(), providerInstanceID; got != want {
		t.Errorf("delete provider instance ID = %q, want %q", got, want)
	}
	if got, want := providerClient.deleteRequest.Msg.GetExpectedRevision(), revision; got != want {
		t.Errorf("delete expected revision = %q, want %q", got, want)
	}
	if got, want := providerClient.deleteRequest.Header().Get("Authorization"), "Bearer "+token; got != want {
		t.Errorf("delete authorization = %q, want bearer credential", got)
	}

	providerClient.deleteRequest = nil
	dependencies.SecretInput.Terminal = true
	stdout, stderr, err = executeCLI(
		t,
		dependencies,
		"yes\n",
		"provider",
		"instance",
		"delete",
		providerInstanceID,
		"--expected-revision",
		revision,
		"--profile",
		profileName,
	)
	if err != nil {
		t.Fatalf("interactive confirmed delete error = %v", err)
	}
	if providerClient.deleteRequest == nil {
		t.Fatal("interactive confirmed delete did not call the server")
	}
	if got := providerClient.deleteRequest.Msg.GetOperationId(); len(got) != 32 {
		t.Errorf("generated delete operation ID = %q, want 32 base64url characters", got)
	}
	if !bytes.Contains(stderr, []byte("Permanently delete provider instance")) {
		t.Errorf("interactive delete stderr = %q, want confirmation prompt", stderr)
	}
	requireNoCLILeak(t, stdout, token)
	requireNoCLILeak(t, stderr, token)

	providerClient.deleteRequest = nil
	_, _, err = executeCLI(
		t,
		dependencies,
		"no\n",
		"provider",
		"instance",
		"delete",
		providerInstanceID,
		"--expected-revision",
		revision,
		"--profile",
		profileName,
	)
	requireCLIError(t, err, clierror.CodeRequestCancelled, 1)
	if providerClient.deleteRequest != nil {
		t.Fatal("declined interactive delete called the server")
	}
}

func TestInteractiveProviderCreateRendersOrderedSchemaAndHidesSecrets(t *testing.T) {
	const (
		profileName = "local"
		server      = "http://127.0.0.1:8080"
		secret      = "interactive-provider-secret"
	)
	configPath := filepath.Join(t.TempDir(), "config.json")
	credentials := cliProviderCredential(server)
	providerClient := &cliProviderServiceFake{providerType: cliProviderType(t)}
	dependencies := testCLIDependencies(configPath, nil, true, credentials, nil, nil)
	secretReader := &cliPasswordReaderSpy{values: [][]byte{[]byte(secret)}}
	dependencies.SecretInput.TerminalReader = secretReader
	dependencies.ProviderClient = providerClient
	setProfile(t, dependencies, profileName, server)
	longValue := strings.Repeat("provider note ", 40)

	stdout, stderr, err := executeCLI(
		t,
		dependencies,
		"\nprovider-user\n"+longValue+"\n",
		"provider",
		"instance",
		"create",
		"jellyfin",
		"--display-name",
		"Living Room",
		"--profile",
		profileName,
	)
	if err != nil {
		t.Fatalf("interactive provider create error = %v", err)
	}
	if providerClient.createRequest == nil {
		t.Fatal("interactive provider create did not call the server")
	}
	if got, want := providerClient.createRequest.Msg.GetConfiguration().AsMap(), map[string]any{
		"api_key":       secret,
		"base_url":      "http://127.0.0.1:8096",
		"optional_note": longValue,
		"user_id":       "provider-user",
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("interactive configuration = %#v, want %#v", got, want)
	}
	if secretReader.calls != 1 {
		t.Errorf("hidden provider secret reads = %d, want 1", secretReader.calls)
	}
	prompt := string(stderr)
	orderedLabels := []string{"Base URL", "User ID", "API key", cliLongProviderTitle}
	lastIndex := -1
	for _, label := range orderedLabels {
		index := strings.Index(prompt, label)
		if index <= lastIndex {
			t.Errorf("provider prompt order for %q in %q", label, prompt)
		}
		lastIndex = index
	}
	if !strings.Contains(prompt, "[default: http://127.0.0.1:8096]") {
		t.Errorf("provider prompt omitted schema default: %q", prompt)
	}
	if !strings.Contains(prompt, cliLongProviderTitle) {
		t.Errorf("provider prompt truncated long title: %q", prompt)
	}
	requireNoCLILeak(t, stdout, secret)
	requireNoCLILeak(t, stderr, secret)
}

func TestInteractiveProviderUpdateOmitsOrReplacesExistingSecret(t *testing.T) {
	const (
		profileName = "local"
		server      = "http://127.0.0.1:8080"
	)
	configPath := filepath.Join(t.TempDir(), "config.json")
	credentials := cliProviderCredential(server)
	providerClient := &cliProviderServiceFake{
		providerInstance: cliProviderInstance(t),
		providerType:     cliProviderType(t),
	}
	dependencies := testCLIDependencies(configPath, nil, true, credentials, nil, nil)
	secretReader := &cliPasswordReaderSpy{values: [][]byte{[]byte("")}}
	dependencies.SecretInput.TerminalReader = secretReader
	dependencies.ProviderClient = providerClient
	setProfile(t, dependencies, profileName, server)

	stdout, stderr, err := executeCLI(
		t,
		dependencies,
		"\n\nupdated note\n",
		"provider",
		"instance",
		"update",
		"provider-instance-1",
		"--expected-revision",
		"revision-1",
		"--profile",
		profileName,
	)
	if err != nil {
		t.Fatalf("interactive provider update error = %v", err)
	}
	if providerClient.updateRequest == nil {
		t.Fatal("interactive provider update did not call the server")
	}
	if got, want := providerClient.updateRequest.Msg.GetConfigurationPatch().AsMap(), map[string]any{
		"optional_note": "updated note",
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("secret-omitting update patch = %#v, want %#v", got, want)
	}
	if !strings.Contains(string(stderr), "configured; Enter to keep") {
		t.Errorf("secret-omitting update prompt = %q, want configured marker", stderr)
	}
	requireNoCLILeak(t, stdout, "stored-provider-secret")
	requireNoCLILeak(t, stderr, "stored-provider-secret")

	const replacement = "replacement-provider-secret"
	providerClient.updateRequest = nil
	dependencies.SecretInput.TerminalReader = &cliPasswordReaderSpy{
		values: [][]byte{[]byte(replacement)},
	}
	stdout, stderr, err = executeCLI(
		t,
		dependencies,
		"\n\n\n",
		"provider",
		"instance",
		"update",
		"provider-instance-1",
		"--expected-revision",
		"revision-1",
		"--profile",
		profileName,
	)
	if err != nil {
		t.Fatalf("interactive provider secret replacement error = %v", err)
	}
	if got, want := providerClient.updateRequest.Msg.GetConfigurationPatch().AsMap(), map[string]any{
		"api_key": replacement,
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("secret replacement patch = %#v, want %#v", got, want)
	}
	requireNoCLILeak(t, stdout, replacement)
	requireNoCLILeak(t, stderr, replacement)

	providerClient.updateRequest = nil
	_, stderr, err = executeCLI(
		t,
		dependencies,
		"",
		"provider",
		"instance",
		"update",
		"provider-instance-1",
		"--expected-revision",
		"revision-1",
		"--clear",
		"optional_note",
		"--profile",
		profileName,
		"--output",
		"json",
	)
	if err != nil {
		t.Fatalf("provider clear update error = %v", err)
	}
	if got, want := providerClient.updateRequest.Msg.GetClearConfigurationFields(), []string{"optional_note"}; !reflect.DeepEqual(got, want) {
		t.Errorf("clear fields = %#v, want %#v", got, want)
	}
	if got := providerClient.updateRequest.Msg.GetConfigurationPatch().AsMap(); len(got) != 0 {
		t.Errorf("clear update patch = %#v, want empty", got)
	}
	if len(stderr) != 0 {
		t.Errorf("JSON clear stderr = %q, want empty", stderr)
	}
}

func TestProviderConfigurationDocumentsRemainNonInteractive(t *testing.T) {
	const (
		profileName = "local"
		server      = "http://127.0.0.1:8080"
		secret      = "document-provider-secret"
	)
	configPath := filepath.Join(t.TempDir(), "config.json")
	configurationPath := filepath.Join(t.TempDir(), "provider.json")
	configuration := `{"api_key":"` + secret + `","base_url":"http://127.0.0.1:8096","user_id":"provider-user"}`
	if err := os.WriteFile(configurationPath, []byte(configuration), 0o600); err != nil {
		t.Fatal(err)
	}
	credentials := cliProviderCredential(server)
	providerClient := &cliProviderServiceFake{providerType: cliProviderType(t)}
	dependencies := testCLIDependencies(configPath, nil, true, credentials, nil, nil)
	secretReader := &cliPasswordReaderSpy{}
	dependencies.SecretInput.TerminalReader = secretReader
	dependencies.ProviderClient = providerClient
	setProfile(t, dependencies, profileName, server)

	for _, test := range []struct {
		name  string
		path  string
		stdin string
	}{
		{name: "file", path: configurationPath},
		{name: "redirected stdin", path: "-", stdin: configuration},
	} {
		t.Run(test.name, func(t *testing.T) {
			providerClient.createRequest = nil
			stdout, stderr, err := executeCLI(
				t,
				dependencies,
				test.stdin,
				"provider",
				"instance",
				"create",
				"jellyfin",
				"--display-name",
				"Living Room",
				"--configuration",
				test.path,
				"--profile",
				profileName,
				"--output",
				"json",
			)
			if err != nil {
				t.Fatalf("%s provider create error = %v", test.name, err)
			}
			if providerClient.createRequest == nil {
				t.Fatalf("%s provider create did not call the server", test.name)
			}
			if secretReader.calls != 0 {
				t.Errorf("%s provider create prompted %d times", test.name, secretReader.calls)
			}
			if len(stderr) != 0 {
				t.Errorf("%s provider create stderr = %q, want empty", test.name, stderr)
			}
			requireNoCLILeak(t, stdout, secret)
		})
	}

	providerClient.createRequest = nil
	_, _, err := executeCLI(
		t,
		dependencies,
		"",
		"provider",
		"instance",
		"create",
		"jellyfin",
		"--display-name",
		"Living Room",
		"--profile",
		profileName,
		"--output",
		"json",
	)
	requireCLIError(t, err, clierror.CodeInvalidArgument, 2)
	if secretReader.calls != 0 {
		t.Errorf("JSON provider create prompted %d times", secretReader.calls)
	}
	if providerClient.createRequest != nil {
		t.Fatal("JSON provider create without configuration called the server")
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

func TestRootHelpVersionAndJSONDiscoveryRules(t *testing.T) {
	dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), nil, false, &cliCredentialStoreFake{}, nil, nil)

	stdout, stderr, err := executeCLI(t, dependencies, "")
	if err != nil {
		t.Fatalf("root help error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("root help stderr = %q, want empty", stderr)
	}
	for _, text := range []string{
		"Manage a Nama server",
		"Profile selection: --profile -> NAMA_PROFILE -> configured default profile",
		"Server target: --server -> NAMA_SERVER -> selected profile",
		"Output mode: --output -> NAMA_OUTPUT -> configured preferred output -> human",
		"absolute HTTP(S)",
		"without credentials, query, or fragment",
		".local",
		"Exit codes",
		"nama profile set",
		"nama setup",
		"nama auth login",
	} {
		if !bytes.Contains(stdout, []byte(text)) {
			t.Errorf("root help does not contain %q:\n%s", text, stdout)
		}
	}
	for _, text := range []string{"logout", "\n  health", "\n  diagnostics", "\n  plugin", "\n  sync", "\n  devices"} {
		if bytes.Contains(stdout, []byte(text)) {
			t.Errorf("root help advertises unimplemented surface %q:\n%s", text, stdout)
		}
	}

	stdout, stderr, err = executeCLI(t, dependencies, "", "--version")
	if err != nil {
		t.Fatalf("human version error = %v", err)
	}
	if got, want := string(stdout), "0.0.0-dev\n"; got != want {
		t.Errorf("human version stdout = %q, want %q", got, want)
	}
	if len(stderr) != 0 {
		t.Errorf("human version stderr = %q, want empty", stderr)
	}

	stdout, stderr, err = executeCLI(t, dependencies, "", "--output", "json", "--version")
	if err != nil {
		t.Fatalf("JSON version error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("JSON version stderr = %q, want empty", stderr)
	}
	data := decodeCLIData(t, stdout)
	if got, want := data["version"], "0.0.0-dev"; got != want {
		t.Errorf("JSON version = %#v, want %q", got, want)
	}

	for _, arguments := range [][]string{
		{"auth", "--version"},
		{"profile", "set", "--version"},
	} {
		stdout, stderr, err = executeCLI(t, dependencies, "", arguments...)
		if err != nil {
			t.Fatalf("global human version %v error = %v", arguments, err)
		}
		if got, want := string(stdout), "0.0.0-dev\n"; got != want || len(stderr) != 0 {
			t.Errorf("global human version %v stdout=%q stderr=%q, want %q and empty", arguments, stdout, stderr, want)
		}
	}
	stdout, stderr, err = executeCLI(t, dependencies, "", "auth", "status", "--version", "--output", "json")
	if err != nil || len(stderr) != 0 {
		t.Fatalf("global JSON version error=%v stderr=%q", err, stderr)
	}
	data = decodeCLIData(t, stdout)
	if got, want := data["version"], "0.0.0-dev"; got != want {
		t.Errorf("global JSON version = %#v, want %q", got, want)
	}

	for _, arguments := range [][]string{
		{"--output", "json"},
		{"--output", "json", "--help"},
		{"--output", "json", "help"},
		{"--output", "json", "help", "auth"},
	} {
		stdout, stderr, err = executeCLI(t, dependencies, "", arguments...)
		requireCLIError(t, err, "invalid_argument", 2)
		if len(stdout) != 0 {
			t.Errorf("JSON discovery %v stdout = %q, want empty", arguments, stdout)
		}
		payload := decodeCLIJSON(t, stderr)
		failure, ok := payload["error"].(map[string]any)
		if !ok {
			t.Fatalf("JSON discovery %v error = %#v, want object", arguments, payload["error"])
		}
		if got, want := failure["code"], "invalid_argument"; got != want {
			t.Errorf("JSON discovery %v code = %#v, want %q", arguments, got, want)
		}
	}
}

func TestCommandHelpDescribesEveryImplementedOperation(t *testing.T) {
	dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), nil, false, &cliCredentialStoreFake{}, nil, nil)
	tests := []struct {
		path []string
		want []string
	}{
		{path: []string{"profile"}, want: []string{"Manage named server profiles"}},
		{path: []string{"profile", "set"}, want: []string{"profile name", "--server", "NAMA_SERVER", "nama profile set"}},
		{path: []string{"profile", "use"}, want: []string{"profile name", "nama profile use"}},
		{path: []string{"profile", "list"}, want: []string{"configured profiles", "nama profile list"}},
		{path: []string{"setup"}, want: []string{"Administrator", "--display-name", "--email", "NAMA_BOOTSTRAP_TOKEN", "stdin", "nama setup"}},
		{path: []string{"auth"}, want: []string{"Administrator authentication"}},
		{path: []string{"auth", "login"}, want: []string{"Administrator email", "password", "stdin", "nama auth login"}},
		{path: []string{"auth", "status"}, want: []string{"NAMA_TOKEN", "nama auth status"}},
		{path: []string{"completion"}, want: []string{"Bash", "Zsh", "Fish", "PowerShell", "<shell>", "nama completion bash"}},
	}

	for _, test := range tests {
		t.Run(strings.Join(test.path, " "), func(t *testing.T) {
			arguments := append([]string{"help"}, test.path...)
			stdout, stderr, err := executeCLI(t, dependencies, "", arguments...)
			if err != nil {
				t.Fatalf("help error = %v", err)
			}
			if len(stderr) != 0 {
				t.Errorf("help stderr = %q, want empty", stderr)
			}
			for _, text := range test.want {
				if !bytes.Contains(stdout, []byte(text)) {
					t.Errorf("help does not contain %q:\n%s", text, stdout)
				}
			}
		})
	}
}

func TestBareCommandFamiliesFailAsInvalidArguments(t *testing.T) {
	dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), nil, false, &cliCredentialStoreFake{}, nil, nil)
	for _, family := range []string{"profile", "auth"} {
		stdout, stderr, err := executeCLI(t, dependencies, "", family, "--output", "json")
		requireCLIError(t, err, "invalid_argument", 2)
		if len(stdout) != 0 {
			t.Errorf("bare %s stdout = %q, want empty", family, stdout)
		}
		decodeCLIJSON(t, stderr)
	}
}

func TestLocalHelpAndVersionSurviveUnreadableConfiguration(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	dependencies := testCLIDependencies(configPath, nil, false, &cliCredentialStoreFake{}, nil, nil)

	stdout, stderr, err := executeCLI(t, dependencies, "")
	if err != nil {
		t.Fatalf("root help with malformed configuration error = %v", err)
	}
	if !bytes.Contains(stdout, []byte("Usage:")) || len(stderr) != 0 {
		t.Errorf("root help with malformed configuration stdout=%q stderr=%q", stdout, stderr)
	}

	stdout, stderr, err = executeCLI(t, dependencies, "", "--version")
	if err != nil {
		t.Fatalf("version with malformed configuration error = %v", err)
	}
	if got, want := string(stdout), "0.0.0-dev\n"; got != want || len(stderr) != 0 {
		t.Errorf("version with malformed configuration stdout=%q stderr=%q, want %q and empty", stdout, stderr, want)
	}
}

func TestLocalDiscoveryIgnoresServerStateAndNeverLeaksRuntimeSecrets(t *testing.T) {
	const (
		bootstrapToken = "runtime-bootstrap-sentinel"
		bearer         = "runtime-bearer-sentinel"
	)
	configDirectory := t.TempDir()
	configPath := filepath.Join(configDirectory, "config.json")
	if err := os.WriteFile(configPath, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	dependencies := testCLIDependencies(configPath, map[string]string{
		"NAMA_PROFILE":         "missing-profile",
		"NAMA_SERVER":          "not-a-server-url",
		"NAMA_BOOTSTRAP_TOKEN": bootstrapToken,
		"NAMA_TOKEN":           bearer,
	}, false, &cliCredentialStoreFake{}, nil, nil)

	streams := make([][]byte, 0)
	for _, arguments := range [][]string{
		{"--version", "--output", "json"},
		{"completion", "bash", "--output", "json"},
		{"schema", "--output", "json"},
	} {
		stdout, stderr, err := executeCLI(t, dependencies, "", arguments...)
		if err != nil {
			t.Fatalf("local discovery %v error = %v", arguments, err)
		}
		if len(stderr) != 0 {
			t.Errorf("local discovery %v stderr = %q, want empty", arguments, stderr)
		}
		decodeCLIData(t, stdout)
		streams = append(streams, stdout, stderr)
	}
	for _, arguments := range [][]string{
		{},
		{"help", "setup"},
		{"help", "auth", "login"},
	} {
		stdout, stderr, err := executeCLI(t, dependencies, "", arguments...)
		if err != nil {
			t.Fatalf("human discovery %v error = %v", arguments, err)
		}
		streams = append(streams, stdout, stderr)
	}
	reference, err := os.ReadFile("../../../../docs/cli/reference.md")
	if err != nil {
		t.Fatal(err)
	}
	streams = append(streams, reference)
	for _, stream := range streams {
		requireNoCLILeak(t, stream, bootstrapToken, bearer)
	}
}

func TestLocalDiscoveryUsesOutputPrecedenceWithoutServerResolution(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	configJSON := `{"profiles":{},"default_profile":"","preferred_output":"json"}`
	if err := os.WriteFile(configPath, []byte(configJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	dependencies := testCLIDependencies(configPath, nil, false, &cliCredentialStoreFake{}, nil, nil)
	stdout, stderr, err := executeCLI(t, dependencies, "", "--version")
	if err != nil || len(stderr) != 0 {
		t.Fatalf("configured JSON version error=%v stderr=%q", err, stderr)
	}
	decodeCLIData(t, stdout)

	stdout, stderr, err = executeCLI(t, dependencies, "", "--help")
	requireCLIError(t, err, "invalid_argument", 2)
	if len(stdout) != 0 {
		t.Errorf("configured JSON help stdout = %q, want empty", stdout)
	}
	decodeCLIJSON(t, stderr)

	dependencies = testCLIDependencies(configPath, map[string]string{"NAMA_OUTPUT": "human"}, false, &cliCredentialStoreFake{}, nil, nil)
	stdout, stderr, err = executeCLI(t, dependencies, "", "--version")
	if err != nil {
		t.Fatalf("environment human version error = %v", err)
	}
	if got, want := string(stdout), "0.0.0-dev\n"; got != want || len(stderr) != 0 {
		t.Errorf("environment human version stdout=%q stderr=%q, want %q and empty", stdout, stderr, want)
	}

	stdout, stderr, err = executeCLI(t, dependencies, "", "--version", "--output", "json")
	if err != nil || len(stderr) != 0 {
		t.Fatalf("flag JSON version error=%v stderr=%q", err, stderr)
	}
	decodeCLIData(t, stdout)
}
func TestSchemaReportsTheCanonicalCommandAndExitContract(t *testing.T) {
	dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), nil, false, &cliCredentialStoreFake{}, nil, nil)

	human, stderr, err := executeCLI(t, dependencies, "", "schema")
	if err != nil {
		t.Fatalf("human schema error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("human schema stderr = %q, want empty", stderr)
	}
	for _, command := range []string{"nama", "nama auth login", "nama completion", "nama profile set", "nama provider instance create", "nama provider instance delete", "nama provider instance update", "nama provider type list", "nama schema"} {
		if !bytes.Contains(human, []byte(command)) {
			t.Errorf("human schema inventory omits %q:\n%s", command, human)
		}
	}

	stdout, stderr, err := executeCLI(t, dependencies, "", "schema", "--output", "json")
	if err != nil {
		t.Fatalf("JSON schema error = %v", err)
	}
	if len(stderr) != 0 {
		t.Errorf("JSON schema stderr = %q, want empty", stderr)
	}
	data := decodeCLIData(t, stdout)
	if got, want := data["schema_version"], float64(1); got != want {
		t.Fatalf("schema_version = %#v, want %#v", got, want)
	}

	commands := schemaObjectList(t, data["commands"], "commands")
	paths := make([]string, 0, len(commands))
	byPath := make(map[string]map[string]any, len(commands))
	for _, command := range commands {
		path := strings.Join(schemaStringList(t, command["path"], "command path"), " ")
		paths = append(paths, path)
		byPath[path] = command
	}
	wantPaths := []string{
		"nama",
		"nama auth",
		"nama auth login",
		"nama auth status",
		"nama completion",
		"nama help",
		"nama profile",
		"nama profile list",
		"nama profile set",
		"nama profile use",
		"nama provider",
		"nama provider instance",
		"nama provider instance create",
		"nama provider instance delete",
		"nama provider instance get",
		"nama provider instance list",
		"nama provider instance update",
		"nama provider type",
		"nama provider type list",
		"nama schema",
		"nama setup",
	}
	if !reflect.DeepEqual(paths, wantPaths) {
		t.Errorf("schema command paths = %#v, want %#v", paths, wantPaths)
	}
	for path, command := range byPath {
		if command["summary"] == "" || command["description"] == "" {
			t.Errorf("%s has incomplete command descriptions", path)
		}
		flags := schemaObjectList(t, command["flags"], path+" flags")
		names := make([]string, 0, len(flags))
		for _, flag := range flags {
			names = append(names, schemaString(t, flag["name"], path+" flag name"))
			if flag["type"] == "" || flag["description"] == "" {
				t.Errorf("%s flag %v has incomplete metadata", path, flag["name"])
			}
		}
		if !slices.IsSorted(names) {
			t.Errorf("%s flags are not canonically ordered: %#v", path, names)
		}
		for _, argument := range schemaObjectList(t, command["arguments"], path+" arguments") {
			if argument["type"] == "" || argument["description"] == "" {
				t.Errorf("%s argument %v has incomplete metadata", path, argument["name"])
			}
		}
		for _, input := range schemaObjectList(t, command["inputs"], path+" inputs") {
			if input["type"] == "" || input["description"] == "" || len(schemaObjectList(t, input["sources"], path+" input sources")) == 0 {
				t.Errorf("%s input %v has incomplete metadata", path, input["name"])
			}
		}
	}

	rootFlags := schemaObjectsByName(t, byPath["nama"]["flags"], "root flags")
	for _, name := range []string{"help", "output", "profile", "server", "version"} {
		if _, ok := rootFlags[name]; !ok {
			t.Errorf("root schema omits --%s", name)
		}
	}
	outputFlag := rootFlags["output"]
	if got, want := outputFlag["type"], "string"; got != want {
		t.Errorf("output flag type = %#v, want %q", got, want)
	}
	if got, want := outputFlag["environment"], "NAMA_OUTPUT"; got != want {
		t.Errorf("output flag environment = %#v, want %q", got, want)
	}
	if got, want := outputFlag["default"], "human"; got != want {
		t.Errorf("output flag default = %#v, want %q", got, want)
	}
	if got, want := schemaStringList(t, outputFlag["allowed_values"], "output allowed values"), []string{"human", "json"}; !reflect.DeepEqual(got, want) {
		t.Errorf("output allowed values = %#v, want %#v", got, want)
	}

	loginFlags := schemaObjectsByName(t, byPath["nama auth login"]["flags"], "login flags")
	if got, want := loginFlags["output"]["inherited"], true; got != want {
		t.Errorf("login output inherited = %#v, want %t", got, want)
	}
	if got, want := loginFlags["version"]["inherited"], true; got != want {
		t.Errorf("login version inherited = %#v, want %t", got, want)
	}
	if got, want := loginFlags["email"]["required"], true; got != want {
		t.Errorf("login email required = %#v, want %t", got, want)
	}

	completionArguments := schemaObjectList(t, byPath["nama completion"]["arguments"], "completion arguments")
	if got, want := len(completionArguments), 1; got != want {
		t.Fatalf("completion arguments = %d, want %d", got, want)
	}
	if got, want := completionArguments[0]["name"], "shell"; got != want {
		t.Errorf("completion argument name = %#v, want %q", got, want)
	}
	if got, want := schemaStringList(t, completionArguments[0]["allowed_values"], "completion shells"), []string{"bash", "fish", "powershell", "zsh"}; !reflect.DeepEqual(got, want) {
		t.Errorf("completion shells = %#v, want %#v", got, want)
	}

	profileSetArguments := schemaObjectList(t, byPath["nama profile set"]["arguments"], "profile set arguments")
	if got, want := profileSetArguments[0]["name"], "name"; got != want {
		t.Errorf("profile set argument name = %#v, want %q", got, want)
	}
	if got, want := profileSetArguments[0]["required"], true; got != want {
		t.Errorf("profile set argument required = %#v, want %t", got, want)
	}

	providerListFlags := schemaObjectsByName(t, byPath["nama provider type list"]["flags"], "provider type list flags")
	if got, want := providerListFlags["page-size"]["default"], "0"; got != want {
		t.Errorf("provider page size default = %#v, want %q", got, want)
	}
	if _, ok := providerListFlags["page-token"]; !ok {
		t.Error("provider type list schema omits --page-token")
	}
	providerListInputs := schemaObjectsByName(t, byPath["nama provider type list"]["inputs"], "provider type list inputs")
	if got, want := providerListInputs["bearer"]["secret"], true; got != want {
		t.Errorf("provider bearer secret = %#v, want %t", got, want)
	}
	if got, want := providerListInputs["bearer"]["required"], true; got != want {
		t.Errorf("provider bearer required = %#v, want %t", got, want)
	}

	providerCreateFlags := schemaObjectsByName(t, byPath["nama provider instance create"]["flags"], "provider instance create flags")
	if got, want := providerCreateFlags["configuration"]["required"], false; got != want {
		t.Errorf("provider create configuration required = %#v, want %t", got, want)
	}
	if got, want := providerCreateFlags["display-name"]["required"], true; got != want {
		t.Errorf("provider create display-name required = %#v, want %t", got, want)
	}
	if got, want := providerCreateFlags["enabled"]["default"], "true"; got != want {
		t.Errorf("provider create enabled default = %#v, want %q", got, want)
	}
	providerCreateArguments := schemaObjectList(t, byPath["nama provider instance create"]["arguments"], "provider instance create arguments")
	if got, want := providerCreateArguments[0]["name"], "provider-type-id"; got != want {
		t.Errorf("provider create argument name = %#v, want %q", got, want)
	}

	providerDeleteFlags := schemaObjectsByName(t, byPath["nama provider instance delete"]["flags"], "provider instance delete flags")
	if got, want := providerDeleteFlags["expected-revision"]["required"], true; got != want {
		t.Errorf("provider delete expected revision required = %#v, want %t", got, want)
	}
	if got, want := providerDeleteFlags["yes"]["default"], "false"; got != want {
		t.Errorf("provider delete yes default = %#v, want %q", got, want)
	}
	providerDeleteArguments := schemaObjectList(t, byPath["nama provider instance delete"]["arguments"], "provider instance delete arguments")
	if got, want := providerDeleteArguments[0]["name"], "provider-instance-id"; got != want {
		t.Errorf("provider delete argument name = %#v, want %q", got, want)
	}

	providerUpdateFlags := schemaObjectsByName(t, byPath["nama provider instance update"]["flags"], "provider instance update flags")
	if got, want := providerUpdateFlags["expected-revision"]["required"], true; got != want {
		t.Errorf("provider update expected revision required = %#v, want %t", got, want)
	}
	for _, name := range []string{"clear", "configuration", "display-name", "enabled", "operation-id", "sync-priority"} {
		if got, want := providerUpdateFlags[name]["required"], false; got != want {
			t.Errorf("provider update %s required = %#v, want %t", name, got, want)
		}
	}
	providerUpdateArguments := schemaObjectList(t, byPath["nama provider instance update"]["arguments"], "provider instance update arguments")
	if got, want := providerUpdateArguments[0]["name"], "provider-instance-id"; got != want {
		t.Errorf("provider update argument name = %#v, want %q", got, want)
	}

	setupInputs := schemaObjectsByName(t, byPath["nama setup"]["inputs"], "setup inputs")
	for _, name := range []string{"bootstrap_token", "password"} {
		input, ok := setupInputs[name]
		if !ok {
			t.Fatalf("setup schema omits %s input", name)
		}
		if got, want := input["secret"], true; got != want {
			t.Errorf("setup %s secret = %#v, want %t", name, got, want)
		}
	}
	bootstrapSources := schemaObjectList(t, setupInputs["bootstrap_token"]["sources"], "bootstrap token sources")
	if got, want := bootstrapSources[1]["name"], "NAMA_BOOTSTRAP_TOKEN"; got != want {
		t.Errorf("bootstrap environment source = %#v, want %q", got, want)
	}
	if got, want := bootstrapSources[2]["condition"], "json_terminal"; got != want {
		t.Errorf("bootstrap rejection condition = %#v, want %q", got, want)
	}

	exitRecords := schemaObjectList(t, data["exit_codes"], "exit codes")
	if got, want := len(exitRecords), 8; got != want {
		t.Fatalf("exit code records = %d, want %d", got, want)
	}
	errorExits := make(map[string]int)
	for index, record := range exitRecords {
		if got, want := record["code"], float64(index); got != want {
			t.Errorf("exit record %d code = %#v, want %#v", index, got, want)
		}
		for _, code := range schemaStringList(t, record["error_codes"], "exit error codes") {
			errorExits[code] = index
		}
	}
	wantErrorExits := map[string]int{
		clierror.CodeUnexpectedFailure:              1,
		clierror.CodeInvalidArgument:                2,
		clierror.CodeInvalidConfiguration:           2,
		clierror.CodeProfileNotFound:                5,
		clierror.CodeCredentialStoreUnavailable:     1,
		clierror.CodeCredentialCleanupFailed:        1,
		clierror.CodeUnsafeTransport:                2,
		clierror.CodeNetworkUnavailable:             7,
		clierror.CodeAlreadyInitialized:             6,
		clierror.CodeAuthenticationFailed:           3,
		clierror.CodeAuthenticationUnavailable:      7,
		clierror.CodeCredentialInvalid:              3,
		clierror.CodeDeadlineExceeded:               7,
		clierror.CodeInternal:                       1,
		clierror.CodeNotInitialized:                 6,
		clierror.CodePermissionDenied:               4,
		clierror.CodeRateLimited:                    7,
		clierror.CodeRequestCancelled:               1,
		clierror.CodeSessionRevocationUnconfirmed:   7,
		clierror.CodeSetupInProgress:                6,
		clierror.CodeSetupUnavailable:               7,
		clierror.CodeValidationFailed:               2,
		clierror.CodeIdempotencyKeyReused:           6,
		clierror.CodePageTokenInvalid:               2,
		clierror.CodePluginUnavailable:              7,
		clierror.CodeProviderAuthenticationFailed:   6,
		clierror.CodeProviderCommitAmbiguous:        7,
		clierror.CodeProviderCredentialsUnavailable: 7,
		clierror.CodeProviderIncompatible:           6,
		clierror.CodeProviderInstanceLimitReached:   7,
		clierror.CodeProviderInstanceBusy:           6,
		clierror.CodeProviderUserChanged:            6,
		clierror.CodeProviderUnavailable:            7,
		clierror.CodeRevisionMismatch:               6,
		clierror.CodeResourceNotFound:               5,
		clierror.CodeUnknown:                        1,
		clierror.CodeCancelled:                      1,
		clierror.CodeNotFound:                       5,
		clierror.CodeAlreadyExists:                  6,
		clierror.CodeResourceExhausted:              7,
		clierror.CodeFailedPrecondition:             6,
		clierror.CodeAborted:                        6,
		clierror.CodeOutOfRange:                     2,
		clierror.CodeUnimplemented:                  1,
		clierror.CodeUnavailable:                    7,
		clierror.CodeDataLoss:                       1,
		clierror.CodeUnauthenticated:                3,
	}
	if !reflect.DeepEqual(errorExits, wantErrorExits) {
		t.Errorf("error exit mappings = %#v, want %#v", errorExits, wantErrorExits)
	}
}

func TestCompletionGeneratesIdenticalHumanAndJSONScripts(t *testing.T) {
	configDirectory := t.TempDir()
	dependencies := testCLIDependencies(filepath.Join(configDirectory, "config.json"), nil, false, &cliCredentialStoreFake{}, nil, nil)

	for _, shell := range []string{"bash", "zsh", "fish", "powershell"} {
		t.Run(shell, func(t *testing.T) {
			human, stderr, err := executeCLI(t, dependencies, "", "completion", shell)
			if err != nil {
				t.Fatalf("human completion error = %v", err)
			}
			if len(human) == 0 || !bytes.Contains(human, []byte("nama")) {
				t.Fatalf("human completion script = %q, want generated nama script", human)
			}
			if !bytes.HasSuffix(human, []byte("\n")) {
				t.Errorf("human completion script has no terminating newline")
			}
			if !bytes.Contains(human, []byte("__complete")) || bytes.Contains(human, []byte("__completeNoDesc")) {
				t.Errorf("human completion script disables command descriptions")
			}
			if len(stderr) != 0 {
				t.Errorf("human completion stderr = %q, want empty", stderr)
			}

			stdout, stderr, err := executeCLI(t, dependencies, "", "completion", shell, "--output", "json")
			if err != nil {
				t.Fatalf("JSON completion error = %v", err)
			}
			if len(stderr) != 0 {
				t.Errorf("JSON completion stderr = %q, want empty", stderr)
			}
			data := decodeCLIData(t, stdout)
			if got, want := data["shell"], shell; got != want {
				t.Errorf("JSON completion shell = %#v, want %q", got, want)
			}
			script, ok := data["script"].(string)
			if !ok {
				t.Fatalf("JSON completion script = %#v, want string", data["script"])
			}
			if got := []byte(script); !bytes.Equal(got, human) {
				t.Errorf("JSON completion script differs from human script")
			}
		})
	}
	entries, err := os.ReadDir(configDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("completion installed files as a side effect: %#v", entries)
	}
}

func TestCompletionRejectsMissingExtraAndUnsupportedShells(t *testing.T) {
	dependencies := testCLIDependencies(filepath.Join(t.TempDir(), "config.json"), nil, false, &cliCredentialStoreFake{}, nil, nil)

	for _, arguments := range [][]string{
		{"completion"},
		{"completion", "bash", "zsh"},
		{"completion", "nu"},
	} {
		stdout, stderr, err := executeCLI(t, dependencies, "", append(arguments, "--output", "json")...)
		requireCLIError(t, err, "invalid_argument", 2)
		if len(stdout) != 0 {
			t.Errorf("invalid completion %v stdout = %q, want empty", arguments, stdout)
		}
		payload := decodeCLIJSON(t, stderr)
		failure, ok := payload["error"].(map[string]any)
		if !ok || failure["code"] != "invalid_argument" {
			t.Errorf("invalid completion %v error = %#v", arguments, payload["error"])
		}
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

func schemaObjectList(t *testing.T, value any, name string) []map[string]any {
	t.Helper()
	values, ok := value.([]any)
	if !ok {
		t.Fatalf("%s = %#v, want array", name, value)
	}
	records := make([]map[string]any, 0, len(values))
	for _, value := range values {
		record, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("%s member = %#v, want object", name, value)
		}
		records = append(records, record)
	}
	return records
}

func schemaObjectsByName(t *testing.T, value any, name string) map[string]map[string]any {
	t.Helper()
	records := make(map[string]map[string]any)
	for _, record := range schemaObjectList(t, value, name) {
		recordName := schemaString(t, record["name"], name+" name")
		records[recordName] = record
	}
	return records
}

func schemaStringList(t *testing.T, value any, name string) []string {
	t.Helper()
	values, ok := value.([]any)
	if !ok {
		t.Fatalf("%s = %#v, want string array", name, value)
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, schemaString(t, value, name))
	}
	return result
}

func schemaString(t *testing.T, value any, name string) string {
	t.Helper()
	result, ok := value.(string)
	if !ok {
		t.Fatalf("%s = %#v, want string", name, value)
	}
	return result
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

var cliLongProviderTitle = strings.Repeat("Long provider note title ", 20)

func cliProviderCredential(server string) *cliCredentialStoreFake {
	return &cliCredentialStoreFake{
		credential: auth.Credential{
			Token:     "administrator-bearer",
			ExpiresAt: time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC),
			Server:    server,
		},
		exists: true,
	}
}

func cliProviderType(t *testing.T) *apiv1.ProviderType {
	t.Helper()
	schema, err := structpb.NewStruct(map[string]any{
		"additionalProperties": false,
		"properties": map[string]any{
			"optional_note": map[string]any{
				"title": cliLongProviderTitle,
				"type":  "string",
			},
			"api_key": map[string]any{
				"title":        "API key",
				"type":         "string",
				"writeOnly":    true,
				"x-nama-order": 3,
			},
			"user_id": map[string]any{
				"title":        "User ID",
				"type":         "string",
				"x-nama-order": 2,
			},
			"base_url": map[string]any{
				"default":      "http://127.0.0.1:8096",
				"title":        "Base URL",
				"type":         "string",
				"x-nama-order": 1,
			},
		},
		"required": []any{"base_url", "user_id", "api_key"},
		"type":     "object",
	})
	if err != nil {
		t.Fatal(err)
	}
	return &apiv1.ProviderType{
		Id:                   "jellyfin",
		DisplayName:          "Jellyfin",
		ConfigurationSchema:  schema,
		SchemaProfileVersion: 1,
		SchemaRevision:       "1",
	}
}

func cliProviderInstance(t *testing.T) *apiv1.ProviderInstance {
	t.Helper()
	configuration, err := structpb.NewStruct(map[string]any{
		"base_url":      "http://127.0.0.1:9096",
		"optional_note": "existing note",
		"user_id":       "provider-user",
	})
	if err != nil {
		t.Fatal(err)
	}
	now := timestamppb.New(time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC))
	return &apiv1.ProviderInstance{
		Id:                "provider-instance-1",
		ProviderTypeId:    "jellyfin",
		DisplayName:       "Living Room",
		Enabled:           true,
		SyncPriority:      1,
		Status:            apiv1.ProviderInstanceStatus_PROVIDER_INSTANCE_STATUS_HEALTHY,
		Configuration:     configuration,
		ConfiguredSecrets: []*apiv1.ConfiguredSecret{{Key: "api_key", Configured: true}},
		Revision:          "revision-1",
		CreatedAt:         now,
		UpdatedAt:         now,
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

type cliProviderServiceFake struct {
	apiv1.ProviderServiceClient
	createRequest    *connect.Request[apiv1.CreateProviderInstanceRequest]
	deleteRequest    *connect.Request[apiv1.DeleteProviderInstanceRequest]
	providerInstance *apiv1.ProviderInstance
	providerType     *apiv1.ProviderType
	updateRequest    *connect.Request[apiv1.UpdateProviderInstanceRequest]
}

func (f *cliProviderServiceFake) DeleteProviderInstance(
	_ context.Context,
	request *connect.Request[apiv1.DeleteProviderInstanceRequest],
) (*connect.Response[apiv1.DeleteProviderInstanceResponse], error) {
	f.deleteRequest = request
	return connect.NewResponse(&apiv1.DeleteProviderInstanceResponse{}), nil
}

func (f *cliProviderServiceFake) ListProviderTypes(
	_ context.Context,
	_ *connect.Request[apiv1.ListProviderTypesRequest],
) (*connect.Response[apiv1.ListProviderTypesResponse], error) {
	providerTypes := []*apiv1.ProviderType{}
	if f.providerType != nil {
		providerTypes = append(providerTypes, f.providerType)
	}
	return connect.NewResponse(&apiv1.ListProviderTypesResponse{ProviderTypes: providerTypes}), nil
}

func (f *cliProviderServiceFake) GetProviderInstance(
	_ context.Context,
	_ *connect.Request[apiv1.GetProviderInstanceRequest],
) (*connect.Response[apiv1.GetProviderInstanceResponse], error) {
	return connect.NewResponse(&apiv1.GetProviderInstanceResponse{
		ProviderInstance: f.providerInstance,
	}), nil
}

func (f *cliProviderServiceFake) CreateProviderInstance(
	_ context.Context,
	request *connect.Request[apiv1.CreateProviderInstanceRequest],
) (*connect.Response[apiv1.CreateProviderInstanceResponse], error) {
	f.createRequest = request
	configuration := request.Msg.GetConfiguration().AsMap()
	_, secretConfigured := configuration["api_key"]
	delete(configuration, "api_key")
	safeConfiguration, err := structpb.NewStruct(configuration)
	if err != nil {
		return nil, err
	}
	now := timestamppb.New(time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC))
	var configuredSecrets []*apiv1.ConfiguredSecret
	if secretConfigured {
		configuredSecrets = []*apiv1.ConfiguredSecret{{Key: "api_key", Configured: true}}
	}
	return connect.NewResponse(&apiv1.CreateProviderInstanceResponse{
		ProviderInstance: &apiv1.ProviderInstance{
			Id:                "provider-instance-1",
			ProviderTypeId:    request.Msg.GetProviderTypeId(),
			DisplayName:       request.Msg.GetDisplayName(),
			Enabled:           request.Msg.GetEnabled(),
			SyncPriority:      1,
			Status:            apiv1.ProviderInstanceStatus_PROVIDER_INSTANCE_STATUS_HEALTHY,
			Configuration:     safeConfiguration,
			ConfiguredSecrets: configuredSecrets,
			Revision:          "revision-1",
			CreatedAt:         now,
			UpdatedAt:         now,
		},
	}), nil
}

func (f *cliProviderServiceFake) UpdateProviderInstance(
	_ context.Context,
	request *connect.Request[apiv1.UpdateProviderInstanceRequest],
) (*connect.Response[apiv1.UpdateProviderInstanceResponse], error) {
	f.updateRequest = request
	return connect.NewResponse(&apiv1.UpdateProviderInstanceResponse{
		ProviderInstance: f.providerInstance,
	}), nil
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
