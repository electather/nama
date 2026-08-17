package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/clierror"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

type statusData struct {
	Server        string               `json:"server"`
	Profile       *string              `json:"profile,omitempty"`
	SignedIn      bool                 `json:"signed_in"`
	Administrator *apiv1.Administrator `json:"administrator,omitempty"`
}

func TestRendererJSONSuccessWritesOneDataObjectToStdout(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	renderer := New(JSON, &stdout, &stderr)

	if err := renderer.Success(statusData{Server: "https://nama.example.test", SignedIn: false}, nil); err != nil {
		t.Fatalf("Success() error = %v", err)
	}

	want := "{\"data\":{\"server\":\"https://nama.example.test\",\"signed_in\":false}}\n"
	if got := stdout.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	if got := stderr.String(); got != "" {
		t.Errorf("stderr = %q, want empty", got)
	}
}
func TestRendererHumanPreservesPrintableASCII(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	renderer := New(Human, &stdout, &stderr)
	profile := `default-"quoted"-\path`

	if err := renderer.Success(statusData{
		Server:   "https://nama.example.test/ordinary",
		Profile:  &profile,
		SignedIn: false,
	}, nil); err != nil {
		t.Fatalf("Success() error = %v", err)
	}

	want := "server: https://nama.example.test/ordinary\nprofile: default-\"quoted\"-\\path\nsigned_in: false\n"
	if got := stdout.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	if got := stderr.String(); got != "" {
		t.Errorf("stderr = %q, want empty", got)
	}
}

func TestRendererHumanEscapesUntrustedControlCharacters(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	renderer := New(Human, &stdout, &stderr)
	profile := "primary\rrewrite"

	if err := renderer.Success(statusData{
		Server:   "https://nama.example.test/path\nnext",
		Profile:  &profile,
		SignedIn: true,
		Administrator: &apiv1.Administrator{
			Id:          "administrator\x1b[2J",
			DisplayName: "\x1b]8;;https://attacker.example\aopen\x1b]8;;\a",
			Email:       "admin\x7f\u009b\u202e@example.test",
		},
	}, []Warning{{
		Code:    "insecure_transport",
		Message: "unsafe \x1b]8;;https://attacker.example\aopen\x1b]8;;\a",
	}}); err != nil {
		t.Fatalf("Success() error = %v", err)
	}

	want := strings.Join([]string{
		`server: https://nama.example.test/path\nnext`,
		`profile: primary\rrewrite`,
		"signed_in: true",
		"administrator:",
		`  id: administrator\x1b[2J`,
		`  display_name: \x1b]8;;https://attacker.example\aopen\x1b]8;;\a`,
		`  email: admin\x7f\u009b\u202e@example.test`,
	}, "\n") + "\n"
	if got := stdout.String(); got != want {
		t.Errorf("stdout = %q, want visible escaped text %q", got, want)
	}
	if lines := strings.Count(stdout.String(), "\n"); lines != 7 {
		t.Errorf("human output contains %d newlines, want only 7 structural line endings", lines)
	}
	for _, raw := range []string{"\r", "\x1b", "\a", "\x7f", "\u009b", "\u202e"} {
		if strings.Contains(stdout.String(), raw) {
			t.Errorf("human output contains raw control %q: %q", raw, stdout.String())
		}
	}
	wantWarning := `Warning: unsafe \x1b]8;;https://attacker.example\aopen\x1b]8;;\a` + "\n"
	if got := stderr.String(); got != wantWarning {
		t.Errorf("stderr = %q, want visible escaped warning %q", got, wantWarning)
	}
	if lines := strings.Count(stderr.String(), "\n"); lines != 1 {
		t.Errorf("human warning contains %d newlines, want one structural line ending", lines)
	}
	for _, raw := range []string{"\r", "\x1b", "\a", "\x7f", "\u009b", "\u202e"} {
		if strings.Contains(stderr.String(), raw) {
			t.Errorf("human warning contains raw control %q: %q", raw, stderr.String())
		}
	}
}

func TestRendererJSONWritesOneObjectWithStandardControlEscapes(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	renderer := New(JSON, &stdout, &stderr)
	value := "line\nreturn\rescape\x1bdel\x7fc1\u009bbidi\u202e"

	if err := renderer.Success(struct {
		Value string `json:"value"`
	}{Value: value}, nil); err != nil {
		t.Fatalf("Success() error = %v", err)
	}

	if lines := bytes.Count(stdout.Bytes(), []byte("\n")); lines != 1 {
		t.Errorf("JSON stdout contains %d newlines, want one object followed by one newline: %q", lines, stdout.String())
	}
	for _, escaped := range []string{`\n`, `\r`, `\u001b`} {
		if !strings.Contains(stdout.String(), escaped) {
			t.Errorf("JSON stdout = %q, want standard escape %q", stdout.String(), escaped)
		}
	}
	for _, raw := range []string{"\r", "\x1b"} {
		if strings.Contains(stdout.String(), raw) {
			t.Errorf("JSON stdout contains raw control %q: %q", raw, stdout.String())
		}
	}
	if !json.Valid(stdout.Bytes()) {
		t.Errorf("JSON stdout is not one valid object: %q", stdout.String())
	}
	var envelope struct {
		Data struct {
			Value string `json:"value"`
		} `json:"data"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("JSON stdout = %q, want one success object: %v", stdout.String(), err)
	}
	if got := envelope.Data.Value; got != value {
		t.Errorf("JSON value = %q, want %q", got, value)
	}
	if got := stderr.String(); got != "" {
		t.Errorf("stderr = %q, want empty", got)
	}
}

func TestRendererJSONFailureWritesOnlySafeErrorObjectToStderr(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	renderer := New(JSON, &stdout, &stderr)
	private := errors.New("password=correct-horse bearer=stored-session-bearer")
	cliErr := clierror.Translate(connect.NewError(connect.CodeInternal, private))

	if err := renderer.Failure(cliErr); err != nil {
		t.Fatalf("Failure() error = %v", err)
	}
	if got := stdout.String(); got != "" {
		t.Errorf("stdout = %q, want empty", got)
	}
	if strings.Count(stderr.String(), "\n") != 1 || !strings.HasSuffix(stderr.String(), "\n") {
		t.Errorf("stderr = %q, want exactly one JSON object followed by one newline", stderr.String())
	}
	for _, secret := range []string{"correct-horse", "stored-session-bearer"} {
		if strings.Contains(stderr.String(), secret) {
			t.Errorf("stderr exposes %q: %q", secret, stderr.String())
		}
	}

	var envelope struct {
		Error map[string]json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(stderr.Bytes(), &envelope); err != nil {
		t.Fatalf("stderr is not one JSON object: %v", err)
	}
	if len(envelope.Error) == 0 {
		t.Fatal("JSON failure has no error envelope")
	}
	for _, optional := range []string{"request_id", "field_violations", "retry_delay"} {
		if _, ok := envelope.Error[optional]; ok {
			t.Errorf("JSON error includes absent optional %q", optional)
		}
	}
}

func TestRendererPlacesWarningsByOutputMode(t *testing.T) {
	warning := Warning{Code: "insecure_transport", Message: "Plain HTTP is not encrypted."}
	for _, test := range []struct {
		name string
		mode Mode
	}{
		{"json", JSON},
		{"human", Human},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			renderer := New(test.mode, &stdout, &stderr)
			if err := renderer.Success(statusData{Server: "http://127.0.0.1:8080", SignedIn: false}, []Warning{warning}); err != nil {
				t.Fatalf("Success() error = %v", err)
			}

			if test.mode == JSON {
				var envelope struct {
					Warnings []Warning `json:"warnings"`
				}
				if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
					t.Fatalf("JSON stdout = %q, want one success object: %v", stdout.String(), err)
				}
				if len(envelope.Warnings) != 1 || envelope.Warnings[0] != warning {
					t.Errorf("JSON warnings = %#v, want %#v", envelope.Warnings, []Warning{warning})
				}
				if got := stderr.String(); got != "" {
					t.Errorf("JSON stderr = %q, want no warning prose", got)
				}
				return
			}
			if strings.Contains(stdout.String(), warning.Code) {
				t.Errorf("human stdout includes structured warning: %q", stdout.String())
			}
			if !strings.Contains(stderr.String(), warning.Message) {
				t.Errorf("human stderr = %q, want warning %q", stderr.String(), warning.Message)
			}
		})
	}
}
