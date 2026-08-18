package surface_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/electather/nama/apps/cli/internal/cli"
	"github.com/electather/nama/apps/cli/internal/surface"
)

func TestSchemaV1MilestoneBaselineRemainsCompatible(t *testing.T) {
	baselineJSON, err := os.ReadFile("testdata/schema-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var baseline surface.Schema
	if err := json.Unmarshal(baselineJSON, &baseline); err != nil {
		t.Fatalf("decode schema-v1 baseline: %v", err)
	}
	current := currentSchema(t)
	if err := surface.CheckCompatibility(baseline, current); err != nil {
		t.Fatalf("schema-v1 semantic compatibility: %v", err)
	}
	currentJSON, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	if err := surface.CheckJSONCompatibility(baselineJSON, currentJSON); err != nil {
		t.Fatalf("schema-v1 JSON compatibility: %v", err)
	}
}

func TestGeneratedCLIReferenceMatchesTheCanonicalTree(t *testing.T) {
	const referencePath = "../../../../docs/cli/reference.md"
	want := surface.RenderReference(currentSchema(t))
	if os.Getenv("NAMA_UPDATE_CLI_REFERENCE") == "1" {
		if err := os.MkdirAll(filepath.Dir(referencePath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(referencePath, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(referencePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("docs/cli/reference.md is stale; run NAMA_UPDATE_CLI_REFERENCE=1 go test ./apps/cli/internal/surface -run TestGeneratedCLIReferenceMatchesTheCanonicalTree")
	}
	for _, text := range []string{
		"# Nama CLI reference",
		"`nama auth login`",
		"`NAMA_BOOTSTRAP_TOKEN`",
		"## Exit codes",
	} {
		if !bytes.Contains(got, []byte(text)) {
			t.Errorf("generated reference omits %q", text)
		}
	}
	for _, text := range []string{
		"0.0.0-dev",
		"Generated at",
		"`nama auth logout`",
		"`nama health`",
		"`nama plugin`",
	} {
		if bytes.Contains(got, []byte(text)) {
			t.Errorf("generated reference contains unstable or unimplemented text %q", text)
		}
	}
}

func TestPasswordInputPublishesCanonicalContract(t *testing.T) {
	const description = "Administrator password"
	want := surface.Input{
		Name:        "password",
		Type:        "string",
		Required:    true,
		Secret:      true,
		Description: description,
		Sources: []surface.InputSource{
			{
				Kind:      surface.InputSourceKindHiddenPrompt,
				Name:      "Password",
				Condition: surface.InputSourceConditionHumanTerminal,
			},
			{
				Kind:      surface.InputSourceKindStdinLine,
				Name:      "stdin",
				Condition: surface.InputSourceConditionNonterminal,
			},
			{
				Kind:      surface.InputSourceKindRejected,
				Name:      "terminal_stdin",
				Condition: surface.InputSourceConditionJSONTerminal,
			},
		},
	}

	if got := surface.PasswordInput(description); !reflect.DeepEqual(got, want) {
		t.Errorf("PasswordInput() = %#v, want %#v", got, want)
	}
}

func currentSchema(t *testing.T) surface.Schema {
	t.Helper()
	root := cli.NewRootCommand(cli.Dependencies{ConfigPath: filepath.Join(t.TempDir(), "config.json")})
	return surface.Extract(root)
}
