package surface

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCheckCompatibilityRejectsBreakingSurfaceChanges(t *testing.T) {
	tests := []struct {
		name   string
		want   string
		mutate func(*Schema)
	}{
		{name: "schema version", want: "schema version", mutate: func(value *Schema) { value.SchemaVersion = 2 }},
		{name: "command removal", want: "command nama do", mutate: func(value *Schema) { value.Commands = value.Commands[:1] }},
		{name: "argument removal", want: "argument target", mutate: func(value *Schema) { value.Commands[1].Arguments = nil }},
		{name: "argument rename", want: "argument target", mutate: func(value *Schema) { value.Commands[1].Arguments[0].Name = "resource" }},
		{name: "argument type", want: "argument target type", mutate: func(value *Schema) { value.Commands[1].Arguments[0].Type = "integer" }},
		{name: "argument requiredness", want: "argument optional", mutate: func(value *Schema) { value.Commands[1].Arguments[1].Required = true }},
		{name: "argument insertion", want: "argument target", mutate: func(value *Schema) {
			value.Commands[1].Arguments = append([]Argument{{Name: "prefix", Type: "string"}}, value.Commands[1].Arguments...)
		}},
		{name: "argument allowed value", want: "argument target allowed value", mutate: func(value *Schema) { value.Commands[1].Arguments[0].AllowedValues = []string{"one"} }},
		{name: "flag removal", want: "flag mode", mutate: func(value *Schema) { value.Commands[1].Flags = nil }},
		{name: "flag rename", want: "flag mode", mutate: func(value *Schema) { value.Commands[1].Flags[0].Name = "format" }},
		{name: "flag type", want: "flag mode type", mutate: func(value *Schema) { value.Commands[1].Flags[0].Type = "bool" }},
		{name: "flag requiredness", want: "flag mode became required", mutate: func(value *Schema) { value.Commands[1].Flags[0].Required = true }},
		{name: "flag inheritance", want: "flag mode inheritance", mutate: func(value *Schema) { value.Commands[1].Flags[0].Inherited = true }},
		{name: "flag environment", want: "flag mode environment", mutate: func(value *Schema) { value.Commands[1].Flags[0].Environment = "NAMA_FORMAT" }},
		{name: "flag default", want: "flag mode default", mutate: func(value *Schema) { value.Commands[1].Flags[0].Default = "two" }},
		{name: "flag allowed value", want: "flag mode allowed value", mutate: func(value *Schema) { value.Commands[1].Flags[0].AllowedValues = []string{"one"} }},
		{name: "new required flag", want: "new flag force is required", mutate: func(value *Schema) {
			value.Commands[1].Flags = append(value.Commands[1].Flags, Flag{Name: "force", Type: "bool", Required: true})
		}},
		{name: "input removal", want: "input password", mutate: func(value *Schema) { value.Commands[1].Inputs = nil }},
		{name: "input rename", want: "input password", mutate: func(value *Schema) { value.Commands[1].Inputs[0].Name = "secret" }},
		{name: "input type", want: "input password type", mutate: func(value *Schema) { value.Commands[1].Inputs[0].Type = "bytes" }},
		{name: "input requiredness", want: "input password became required", mutate: func(value *Schema) { value.Commands[1].Inputs[0].Required = true }},
		{name: "input secret classification", want: "input password secret", mutate: func(value *Schema) { value.Commands[1].Inputs[0].Secret = false }},
		{name: "input source", want: "input password sources", mutate: func(value *Schema) { value.Commands[1].Inputs[0].Sources[0].Kind = "argument" }},
		{name: "new required input", want: "new input token is required", mutate: func(value *Schema) {
			value.Commands[1].Inputs = append(value.Commands[1].Inputs, Input{Name: "token", Type: "string", Required: true})
		}},
		{name: "exit removal", want: "exit code 2", mutate: func(value *Schema) { value.ExitCodes = value.ExitCodes[:1] }},
		{name: "exit meaning", want: "exit code 2 meaning", mutate: func(value *Schema) { value.ExitCodes[1].Meaning = "bad input" }},
		{name: "error mapping", want: "error invalid_argument", mutate: func(value *Schema) {
			value.ExitCodes[0].ErrorCodes = []string{"invalid_argument"}
			value.ExitCodes[1].ErrorCodes = nil
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			current := cloneSchema(t, compatibilityFixture())
			test.mutate(&current)
			err := CheckCompatibility(compatibilityFixture(), current)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("compatibility error = %v, want text %q", err, test.want)
			}
		})
	}
}

func TestCheckCompatibilityAcceptsAdditiveOptionalGrowthAndCopyChanges(t *testing.T) {
	baseline := compatibilityFixture()
	current := cloneSchema(t, baseline)
	current.Commands[1].Summary = "Clearer summary"
	current.Commands[1].Description = "Clearer description"
	current.Commands[1].Arguments[0].Description = "Clearer argument"
	current.Commands[1].Arguments[0].Required = false
	current.Commands[1].Arguments[0].AllowedValues = append(current.Commands[1].Arguments[0].AllowedValues, "three")
	current.Commands[1].Arguments = append(current.Commands[1].Arguments, Argument{Name: "suffix", Type: "string"})
	current.Commands[1].Flags[0].Description = "Clearer flag"
	current.Commands[1].Flags[0].AllowedValues = append(current.Commands[1].Flags[0].AllowedValues, "three")
	current.Commands[1].Flags = append(current.Commands[1].Flags, Flag{Name: "quiet", Type: "bool"})
	current.Commands[1].Inputs[0].Description = "Clearer input"
	current.Commands[1].Inputs = append(current.Commands[1].Inputs, Input{Name: "note", Type: "string", Sources: []InputSource{}})
	current.Commands = append(current.Commands, Command{Path: []string{"nama", "new"}, Arguments: []Argument{}, Flags: []Flag{}, Inputs: []Input{}})
	current.ExitCodes[1].ErrorCodes = append(current.ExitCodes[1].ErrorCodes, "new_invalid_argument")

	if err := CheckCompatibility(baseline, current); err != nil {
		t.Fatalf("additive compatibility error = %v", err)
	}
}

func TestCheckJSONCompatibilityRejectsFieldRemovalAndTypeChange(t *testing.T) {
	baseline := compatibilityFixtureJSON(t)
	for _, test := range []struct {
		name   string
		want   string
		mutate func(map[string]any)
	}{
		{name: "field removal", want: "command nama do field summary", mutate: func(value map[string]any) {
			delete(jsonCommand(t, value, 1), "summary")
		}},
		{name: "field type", want: "flag mode field required", mutate: func(value map[string]any) {
			jsonFlag(t, value, 1, 0)["required"] = "false"
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var current map[string]any
			if err := json.Unmarshal(baseline, &current); err != nil {
				t.Fatal(err)
			}
			test.mutate(current)
			encoded, err := json.Marshal(current)
			if err != nil {
				t.Fatal(err)
			}
			err = CheckJSONCompatibility(baseline, encoded)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("JSON compatibility error = %v, want text %q", err, test.want)
			}
		})
	}
}

func compatibilityFixture() Schema {
	return Schema{
		SchemaVersion: 1,
		Commands: []Command{
			{Path: []string{"nama"}, Summary: "Root", Description: "Root", Arguments: []Argument{}, Flags: []Flag{}, Inputs: []Input{}},
			{
				Path:        []string{"nama", "do"},
				Summary:     "Do work",
				Description: "Do work safely",
				Arguments: []Argument{
					{Name: "target", Type: "string", Required: true, Description: "Target", AllowedValues: []string{"one", "two"}},
					{Name: "optional", Type: "string", Description: "Optional", AllowedValues: []string{}},
				},
				Flags: []Flag{{Name: "mode", Type: "string", Description: "Mode", Environment: "NAMA_MODE", Default: "one", AllowedValues: []string{"one", "two"}}},
				Inputs: []Input{{
					Name: "password", Type: "string", Secret: true, Description: "Password",
					Sources: []InputSource{{Kind: "stdin_line", Name: "stdin", Condition: "nonterminal"}},
				}},
			},
		},
		ExitCodes: []ExitCode{
			{Code: 0, Meaning: "success", ErrorCodes: []string{}},
			{Code: 2, Meaning: "invalid arguments", ErrorCodes: []string{"invalid_argument"}},
		},
	}
}

func cloneSchema(t *testing.T, value Schema) Schema {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var clone Schema
	if err := json.Unmarshal(encoded, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}

func compatibilityFixtureJSON(t *testing.T) []byte {
	t.Helper()
	encoded, err := json.Marshal(compatibilityFixture())
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func jsonCommand(t *testing.T, value map[string]any, index int) map[string]any {
	t.Helper()
	commands := value["commands"].([]any)
	return commands[index].(map[string]any)
}

func jsonFlag(t *testing.T, value map[string]any, command, flag int) map[string]any {
	t.Helper()
	flags := jsonCommand(t, value, command)["flags"].([]any)
	return flags[flag].(map[string]any)
}
