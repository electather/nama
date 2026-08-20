package cli

import (
	"bytes"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"

	credentialauth "github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	"github.com/spf13/cobra"
)

type providerPasswordReader struct {
	calls int
	value []byte
}

func (r *providerPasswordReader) ReadPassword(int) ([]byte, error) {
	r.calls++
	return r.value, nil
}

func providerPromptInput(t *testing.T, input string) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "provider-prompt-input")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := file.Close(); err != nil {
			t.Errorf("close provider prompt input: %v", err)
		}
	})
	if _, err := io.WriteString(file, input); err != nil {
		t.Fatal(err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	return file
}

func providerPromptSchema(property map[string]any) map[string]any {
	return map[string]any{
		"properties": map[string]any{"value": property},
		"required":   []any{"value"},
	}
}

func TestProviderPasswordFormatUsesHiddenInputWithoutClassifyingTheValueAsWriteOnly(t *testing.T) {
	stdin := providerPromptInput(t, "")
	var prompt bytes.Buffer
	command := &cobra.Command{}
	command.SetIn(stdin)
	command.SetErr(&prompt)
	reader := &providerPasswordReader{value: []byte("masked-provider-value")}

	configuration, err := promptProviderConfiguration(
		command,
		credentialauth.SecretInput{
			Stdin:          stdin,
			Terminal:       true,
			TerminalReader: reader,
		},
		providerPromptSchema(map[string]any{
			"format": "password",
			"title":  "Provider password",
			"type":   "string",
		}),
		nil,
	)
	if err != nil {
		t.Fatalf("password-format provider prompt error = %v", err)
	}
	if want := map[string]any{"value": "masked-provider-value"}; !reflect.DeepEqual(configuration, want) {
		t.Errorf("password-format configuration = %#v, want %#v", configuration, want)
	}
	if reader.calls != 1 {
		t.Errorf("hidden password reads = %d, want 1", reader.calls)
	}
	if strings.Contains(prompt.String(), "masked-provider-value") {
		t.Errorf("password-format prompt exposed the value: %q", prompt.String())
	}
}

func TestProviderControlsRejectRestrictedSchemaConstraintViolations(t *testing.T) {
	for _, test := range []struct {
		name     string
		input    string
		property map[string]any
	}{
		{name: "enum", input: "fast\n", property: map[string]any{"enum": []any{"safe"}, "type": "string"}},
		{name: "minimum length", input: "ab\n", property: map[string]any{"minLength": float64(3), "type": "string"}},
		{name: "maximum length", input: "abcd\n", property: map[string]any{"maxLength": float64(3), "type": "string"}},
		{name: "URI format", input: "not a URI\n", property: map[string]any{"format": "uri", "type": "string"}},
		{name: "hostname format", input: "bad host\n", property: map[string]any{"format": "hostname", "type": "string"}},
		{name: "minimum", input: "4\n", property: map[string]any{"minimum": float64(5), "type": "integer"}},
		{name: "maximum", input: "6\n", property: map[string]any{"maximum": float64(5), "type": "number"}},
		{name: "minimum items", input: "[]\n", property: map[string]any{"items": map[string]any{"type": "string"}, "minItems": float64(1), "type": "array"}},
		{name: "maximum items", input: "[\"a\",\"b\"]\n", property: map[string]any{"items": map[string]any{"type": "string"}, "maxItems": float64(1), "type": "array"}},
		{name: "unique items", input: "[\"a\",\"a\"]\n", property: map[string]any{"items": map[string]any{"type": "string"}, "type": "array", "uniqueItems": true}},
		{name: "item enum", input: "[\"fast\"]\n", property: map[string]any{"items": map[string]any{"enum": []any{"safe"}, "type": "string"}, "type": "array"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			stdin := providerPromptInput(t, test.input)
			command := &cobra.Command{}
			command.SetIn(stdin)
			command.SetErr(io.Discard)

			_, err := promptProviderConfiguration(
				command,
				credentialauth.SecretInput{Stdin: stdin, Terminal: true},
				providerPromptSchema(test.property),
				nil,
			)
			var cliErr *clierror.Error
			if !errors.As(err, &cliErr) || cliErr.Code != clierror.CodeInvalidArgument {
				t.Fatalf("constraint violation error = %v, want invalid_argument", err)
			}
		})
	}
}

func TestProviderEnumControlRendersAllowedValues(t *testing.T) {
	stdin := providerPromptInput(t, "safe\n")
	var prompt bytes.Buffer
	command := &cobra.Command{}
	command.SetIn(stdin)
	command.SetErr(&prompt)

	configuration, err := promptProviderConfiguration(
		command,
		credentialauth.SecretInput{Stdin: stdin, Terminal: true},
		providerPromptSchema(map[string]any{
			"enum":  []any{"safe", "strict"},
			"title": "Mode",
			"type":  "string",
		}),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"value": "safe"}; !reflect.DeepEqual(configuration, want) {
		t.Errorf("enum configuration = %#v, want %#v", configuration, want)
	}
	if !strings.Contains(prompt.String(), "allowed: safe, strict") {
		t.Errorf("enum prompt = %q, want allowed values", prompt.String())
	}
}
